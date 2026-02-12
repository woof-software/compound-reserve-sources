# Reserve Sources

## Quick Start
```bash
yarn install
```

This installs Husky and sets up the git hook.


⚠️ Recommendation: **commit through the terminal** (use `git commit`) so you can always see all changes before finalizing a commit.

## Overview
This repository stores JSON datasets and validates them before commit.
The validation ensures each JSON item includes all required fields.

These files are part of the
`woof-software/compound-reserve-growth-backend` repository and represent
seed data used to initialize the database before starting data collection.

## Data Files
### `data/sources.json`
Each item defines a reserve source (market or contract) to track:
- `id`: unique source identifier
- `address`: on-chain contract address
- `market`: market label (nullable)
- `algorithm`: data collection strategy identifier
- `startBlock`: first block to start scanning
- `endBlock`: last block to scan (nullable)
- `chainId`: EVM chain ID
- `assetId`: foreign key to `assets.json`
- `type`: human-readable source type

### `data/assets.json`
Each item defines a tracked asset:
- `id`: unique asset identifier
- `address`: token contract address (or zero/native address)
- `decimals`: token decimals
- `symbol`: asset symbol
- `chainId`: EVM chain ID
- `type`: asset category

## Validation

The validator (`scripts/validate-data.js`) runs as a staged pipeline with a shared context. Config rules live in `data/data.config.json`.

**What it does:** loads config, validates each listed file (exists, root is array, items have required fields and correct types), normalizes address fields to checksummed EVM format, persists normalized JSON to disk when changes occur, then reports results.

**Execution behavior:**
- Config errors are fail-fast (script exits before file validation).
- File/item errors are accumulated and printed once at the end.
- Normalization runs only when validation succeeds.
- Persistence runs only when there are no errors and only rewrites files that changed.

**Supported field types:** `string`, `number`, `boolean`, `address`, `nullableString`, `nullableNumber`, `nullableAddress`.

- `address` — EVM address validated with ethers; normalized to checksum format.
- `nullableAddress` — same as `address`, but `null` is allowed; non-null values are checksummed.

Normalization uses ethers `getAddress` for `address` and `nullableAddress`, then writes updates safely via temp file + rename.

**Run:** `yarn validate:data`

**Extending:** Add a new step to the `steps` array in `validate-data.js`; access `ctx.config`, `ctx.loadedFiles`, and `ctx.errors`. To support new types, add a validator to `typeValidators` and include the type in `allowedTypes`.

## Git Hooks
Husky runs the validation on `pre-commit` to prevent invalid data from being committed.

## Scripts
- `yarn prepare` — install Husky and run the repo setup hook
- `yarn validate:data` — run validation manually
- `yarn format` — format JS scripts
