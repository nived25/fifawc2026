import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || './data';

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export function read(name) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function write(name, data) {
  const p = join(DATA_DIR, name);
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

export function readOr(name, fallback) {
  return read(name) ?? fallback;
}
