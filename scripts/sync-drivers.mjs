#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SOURCE_JSON = path.join(ROOT, 'docs', 'data', 'driver-overrides.json');
const TARGETS = [
  { file: path.join(ROOT, 'docs', 'js', 'config.js'), prefix: 'export const DRIVER_NAME_OVERRIDES = ' },
  { file: path.join(ROOT, 'cloudflare-worker', 'worker.js'), prefix: 'const DRIVER_NAME_OVERRIDES = ' }
];

const checkOnly = process.argv.includes('--check');
const overrides = JSON.parse(fs.readFileSync(SOURCE_JSON, 'utf8'));

const formatObjectLiteral = (obj) => {
  const entries = Object.entries(obj).map(
    ([k, v]) => `  '${String(k).replace(/'/g, "\\'")}': '${String(v).replace(/'/g, "\\'")}'`
  );
  return `{\n${entries.join(',\n')}\n};`;
};

const formatted = formatObjectLiteral(overrides);
let outOfSync = 0;

for (const t of TARGETS) {
  const src = fs.readFileSync(t.file, 'utf8');
  const re = new RegExp(`(${t.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\{[\\s\\S]*?\\n\\};`);
  const match = src.match(re);
  if (!match) {
    console.error(`ERROR: Could not find DRIVER_NAME_OVERRIDES block in ${path.relative(ROOT, t.file)}`);
    process.exit(1);
  }
  const replacement = `${t.prefix}${formatted}`;
  const updated = src.replace(re, replacement);
  if (updated !== src) {
    if (checkOnly) {
      console.error(`OUT OF SYNC: ${path.relative(ROOT, t.file)} differs from docs/data/driver-overrides.json`);
      outOfSync++;
    } else {
      fs.writeFileSync(t.file, updated, 'utf8');
      console.log(`Synced ${Object.keys(overrides).length} driver overrides -> ${path.relative(ROOT, t.file)}`);
    }
  } else if (!checkOnly) {
    console.log(`Up to date: ${path.relative(ROOT, t.file)}`);
  }
}

if (checkOnly && outOfSync > 0) {
  console.error('Run `npm run sync:drivers` to synchronize DRIVER_NAME_OVERRIDES.');
  process.exit(1);
}
if (checkOnly) {
  console.log(`✓ All ${Object.keys(overrides).length} DRIVER_NAME_OVERRIDES are synchronized across source & targets.`);
}
