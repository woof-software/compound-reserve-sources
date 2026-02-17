// noinspection D

const fs = require('fs');
const path = require('path');
const { isAddress, getAddress } = require('ethers');

// --- Helpers ---

const isEvmAddress = (value) => typeof value === 'string' && isAddress(value);

const readJson = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
};

// --- Type validators ---

const typeValidators = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  boolean: (value) => typeof value === 'boolean',
  address: (value) => isEvmAddress(value),
  nullableString: (value) => value === null || typeof value === 'string',
  nullableNumber: (value) =>
    value === null || (typeof value === 'number' && Number.isFinite(value)),
  nullableAddress: (value) => value === null || isEvmAddress(value),
};

const allowedTypes = new Set(Object.keys(typeValidators));
const sortableFiles = new Set(['data/assets.json', 'data/sources.json']);

// --- Shared context factory ---

function createContext() {
  const rootDir = path.resolve(__dirname, '..');
  return {
    rootDir,
    configPath: path.join(rootDir, 'data/data.config.json'),
    errors: [],
    config: undefined,
    allowedTypes,
    typeValidators,
    stats: { filesChecked: 0, itemsChecked: 0 },
    loadedFiles: [],
  };
}

// --- Pipeline steps ---

/**
 * Step A — Load and parse the config file.
 * On failure, pushes a [config] error and leaves ctx.config unset.
 */
function loadConfigStep(ctx) {
  try {
    ctx.config = readJson(ctx.configPath);
  } catch (error) {
    ctx.errors.push(`[config] ${error.message}`);
  }
}

/**
 * Step B — Validate the config structure.
 * Checks root shape, files array, each entry's path/fields, unique field names,
 * and allowed types. Skips entirely when ctx.config was not loaded.
 */
function validateConfigStep(ctx) {
  // If config failed to load, the error is already recorded — nothing to validate.
  if (ctx.config === undefined) {
    ctx.errors.push('[config] Config failed to load');
    return;
  }

  if (!ctx.config || typeof ctx.config !== 'object' || Array.isArray(ctx.config)) {
    ctx.errors.push('[config] Root must be an object');
    return;
  }

  if (!Array.isArray(ctx.config.files) || ctx.config.files.length === 0) {
    ctx.errors.push('[config] "files" must be a non-empty array');
    return;
  }

  ctx.config.files.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      ctx.errors.push(`[config] File entry #${index} must be an object`);
      return;
    }

    const { path: filePath, fields } = entry;

    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      ctx.errors.push(`[config] File entry #${index} has invalid "path"`);
    }

    if (!Array.isArray(fields) || fields.length === 0) {
      ctx.errors.push(`[config] File entry #${index} has invalid "fields"`);
      return;
    }

    const fieldNames = new Set();
    fields.forEach((field, fieldIndex) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        ctx.errors.push(`[config] File entry #${index} field #${fieldIndex} must be an object`);
        return;
      }

      const { name, type } = field;

      if (typeof name !== 'string' || name.trim().length === 0) {
        ctx.errors.push(`[config] File entry #${index} field #${fieldIndex} has invalid "name"`);
      } else if (fieldNames.has(name)) {
        ctx.errors.push(`[config] File entry #${index} has duplicate field name "${name}"`);
      } else {
        fieldNames.add(name);
      }

      if (typeof type !== 'string' || !ctx.allowedTypes.has(type)) {
        ctx.errors.push(`[config] File entry #${index} field #${fieldIndex} has invalid "type"`);
      }
    });
  });
}

/**
 * Step C — Validate each JSON file declared in the config.
 * Checks file existence, JSON parse, root-is-array, each item is an object,
 * required fields exist, and types match. Skips when config is absent or
 * earlier steps already recorded errors.
 */
function validateFilesStep(ctx) {
  // If config was not loaded or previous steps found errors, skip file validation
  // (mirrors original behavior: config errors prevent file-level checks).
  if (!ctx.config || ctx.errors.length > 0) return;
  if (!Array.isArray(ctx.config.files)) return;

  for (const { path: file, fields } of ctx.config.files) {
    const filePath = path.join(ctx.rootDir, file);
    ctx.stats.filesChecked++;

    if (!fs.existsSync(filePath)) {
      ctx.errors.push(`[${file}] File not found`);
      continue;
    }

    let data;
    try {
      data = readJson(filePath);
    } catch (error) {
      ctx.errors.push(`[${file}] ${error.message}`);
      continue;
    }

    if (!Array.isArray(data)) {
      ctx.errors.push(`[${file}] Root JSON must be an array`);
      continue;
    }

    ctx.loadedFiles.push({
      file,
      filePath,
      data,
      fields,
      changed: false,
      normalizedIds: new Set(),
    });

    data.forEach((item, index) => {
      ctx.stats.itemsChecked++;

      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        ctx.errors.push(`[${file}] Item #${index} is not an object`);
        return;
      }

      const missing = fields
        .map((field) => field.name)
        .filter((fieldName) => !Object.prototype.hasOwnProperty.call(item, fieldName));

      if (missing.length > 0) {
        const idHint = Object.prototype.hasOwnProperty.call(item, 'id') ? ` (id=${item.id})` : '';
        ctx.errors.push(`[${file}] Item #${index}${idHint} missing fields: ${missing.join(', ')}`);
        return;
      }

      fields.forEach((field) => {
        const value = item[field.name];
        const validator = ctx.typeValidators[field.type];

        if (!validator(value)) {
          const idHint = Object.prototype.hasOwnProperty.call(item, 'id') ? ` (id=${item.id})` : '';
          ctx.errors.push(
            `[${file}] Item #${index}${idHint} invalid "${field.name}" type (expected ${field.type})`,
          );
        }
      });
    });
  }
}

/**
 * Step D — Ensure item IDs are unique inside each loaded file.
 * Skips when earlier validation already found errors.
 */
function validateUniqueIdsStep(ctx) {
  if (ctx.errors.length > 0) return;
  if (!ctx.loadedFiles || ctx.loadedFiles.length === 0) return;

  for (const loaded of ctx.loadedFiles) {
    const seenIds = new Set();
    const duplicateIds = new Set();

    loaded.data.forEach((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      if (!Object.prototype.hasOwnProperty.call(item, 'id')) return;

      const { id } = item;
      if (seenIds.has(id)) {
        duplicateIds.add(id);
        return;
      }
      seenIds.add(id);
    });

    if (duplicateIds.size > 0) {
      const duplicates = Array.from(duplicateIds).join(', ');
      ctx.errors.push(`[${loaded.file}] Duplicate id values found: ${duplicates}`);
    }
  }
}

/**
 * Step E — Sort selected files by id in descending order.
 * Runs only when earlier validation succeeded.
 */
function sortByDescendingIdStep(ctx) {
  if (ctx.errors.length > 0) return;
  if (!ctx.loadedFiles || ctx.loadedFiles.length === 0) return;

  for (const loaded of ctx.loadedFiles) {
    if (!sortableFiles.has(loaded.file)) continue;

    const sorted = [...loaded.data].sort((a, b) => b.id - a.id);
    const isDifferentOrder = sorted.some((item, index) => item !== loaded.data[index]);

    if (isDifferentOrder) {
      loaded.data.splice(0, loaded.data.length, ...sorted);
      loaded.changed = true;
    }
  }
}

/**
 * Step F — Normalize address fields to checksummed EVM addresses.
 * Runs only when validation passed (no errors). For each loaded file and item,
 * applies getAddress to address and nullableAddress fields. Invalid values
 * are not fixed; normalization errors are recorded.
 */
function normalizeStep(ctx) {
  if (ctx.errors.length > 0) return;
  if (!ctx.loadedFiles || ctx.loadedFiles.length === 0) return;

  for (const loaded of ctx.loadedFiles) {
    const { file, data, fields } = loaded;
    for (let index = 0; index < data.length; index++) {
      const item = data[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

      for (const field of fields) {
        const { name, type } = field;
        if (type !== 'address' && type !== 'nullableAddress') continue;

        const value = item[name];
        if (type === 'nullableAddress' && value === null) continue;

        try {
          const checksummed = getAddress(value);
          if (checksummed !== value) {
            item[name] = checksummed;
            loaded.changed = true;
            loaded.normalizedIds.add(item.id);
          }
        } catch (error) {
          const idHint = Object.prototype.hasOwnProperty.call(item, 'id') ? ` (id=${item.id})` : '';
          ctx.errors.push(`[${file}] Item #${index}${idHint} failed to normalize "${name}"`);
        }
      }
    }
  }
}

/**
 * Step G — Persist changed files to disk.
 * Runs only when validation/transformations succeeded; writes only files
 * marked as changed, using temp-file + rename for safer replacement.
 */
function persistChangedFilesStep(ctx) {
  if (ctx.errors.length > 0) return;
  if (!ctx.loadedFiles || ctx.loadedFiles.length === 0) return;

  for (const loaded of ctx.loadedFiles) {
    if (!loaded.changed) continue;

    const tempPath = `${loaded.filePath}.tmp`;
    try {
      const json = `${JSON.stringify(loaded.data, null, 2)}\n`;
      fs.writeFileSync(tempPath, json, 'utf8');
      fs.renameSync(tempPath, loaded.filePath);
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_cleanupError) {
        // Best effort cleanup only.
      }
      ctx.errors.push(`[${loaded.file}] Failed to write changed file: ${error.message}`);
    }
  }
}

/**
 * Step H — Finalize: report results and exit.
 * This is the single place that decides whether to print errors or success.
 */
function finalizeStep(ctx) {
  if (ctx.errors.length > 0) {
    console.error('JSON validation failed:');
    ctx.errors.forEach((message) => console.error(`- ${message}`));
    process.exit(1);
  }

  console.log('JSON validation passed.');

  const rewritten = (ctx.loadedFiles ?? []).filter((loaded) => loaded.changed);

  if (rewritten.length === 0) {
    console.log('No files needed normalization or sorting.');
    return;
  }

  console.log('Rewritten files (normalized and/or sorted):');
  for (const loaded of rewritten) {
    const ids = Array.from(loaded.normalizedIds ?? []);
    const idsText = ids.length > 0 ? ids.join(', ') : '(no ids tracked)';
    console.log(`- ${loaded.file}: ${idsText}`);
  }
}

// --- Pipeline runner ---

/**
 * Execute an ordered list of synchronous steps, passing the shared context
 * to each one. Steps read/write ctx freely; the runner simply iterates.
 */
function runPipeline(steps, ctx) {
  for (const step of steps) {
    step(ctx);
  }
}

// --- Main ---

const steps = [
  loadConfigStep,
  validateConfigStep,
  validateFilesStep,
  validateUniqueIdsStep,
  sortByDescendingIdStep,
  normalizeStep,
  persistChangedFilesStep,
  finalizeStep,
];
const ctx = createContext();
runPipeline(steps, ctx);
