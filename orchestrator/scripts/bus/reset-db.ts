#!/usr/bin/env tsx
/**
 * Wipe the bus SQLite file (and its WAL/shm sidecars) for dev.
 *
 * Resolves the path from $BUS_DB or defaults to ./app.db. Refuses to run
 * if the path looks like an absolute system file (only matches files
 * under the cwd or starting with `./`).
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const target = process.env.BUS_DB ?? './app.db';
const abs = resolve(target);

const cwd = process.cwd();
if (!abs.startsWith(cwd)) {
  console.error(`refusing to delete ${abs} — not under cwd ${cwd}`);
  process.exit(1);
}

for (const suffix of ['', '-wal', '-shm']) {
  const p = abs + suffix;
  if (existsSync(p)) {
    rmSync(p);
    console.log(`removed ${p}`);
  }
}
