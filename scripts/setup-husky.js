const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const huskyDir = path.join(rootDir, '.husky');
const hookPath = path.join(huskyDir, 'pre-commit');

const hookContent = `yarn -s run validate:data
git add -A -- data
`;

fs.mkdirSync(huskyDir, { recursive: true });

// Always overwrite the hook (idempotent setup)
fs.writeFileSync(hookPath, hookContent, { encoding: 'utf8', flag: 'w' });

fs.chmodSync(hookPath, 0o755);
