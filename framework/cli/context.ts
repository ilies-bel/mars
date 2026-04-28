import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  type SearchHit,
  SearchHitSchema,
  type TreeEntry,
  TreeEntrySchema,
} from '../contract/context.ts';
import { type ProcessResult, type SpawnFn, realSpawn } from '../runtime/process.ts';

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

export interface SearchOpts {
  cwd?: string;
  path?: string;
  type?: string;
  spawn?: SpawnFn;
}

export interface TreeOpts {
  cwd?: string;
  depth?: number;
}

const RG_MISSING_HINT =
  'ripgrep ("rg") was not found on PATH. Install it with `brew install ripgrep` or `apt install ripgrep`.';

export async function runSearch(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (trimmed === '') {
    throw new ContextError('search query must be non-empty');
  }
  const cwd = opts.cwd ?? process.cwd();
  const spawn = opts.spawn ?? realSpawn;

  const argv: string[] = ['rg', '--json', '--no-messages'];
  if (opts.type !== undefined && opts.type.length > 0) {
    argv.push('--type', opts.type);
  }
  argv.push('--', trimmed);
  if (opts.path !== undefined && opts.path.length > 0) {
    argv.push(opts.path);
  }

  let result: ProcessResult;
  try {
    result = await spawn(argv, { cwd });
  } catch (err: unknown) {
    if (err instanceof Error && /ENOENT|not found/i.test(err.message)) {
      throw new ContextError(RG_MISSING_HINT);
    }
    throw err;
  }

  if (result.exitCode === 127 || (/not found/i.test(result.stderr) && result.stdout === '')) {
    throw new ContextError(RG_MISSING_HINT);
  }
  // ripgrep: 0 = matches, 1 = no matches, 2 = error
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    throw new ContextError(
      `ripgrep failed (exit ${result.exitCode}): ${result.stderr.trim() || '(no stderr)'}`,
    );
  }

  return parseRgJson(result.stdout);
}

function parseRgJson(stdout: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const rawLine of stdout.split('\n')) {
    if (rawLine === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (!isMatchEvent(event)) continue;
    const data = event.data;
    const path = data.path.text;
    const line = data.line_number;
    const text = data.lines.text.replace(/\r?\n$/, '');
    const submatches = data.submatches;
    const col = submatches.length > 0 && submatches[0] ? submatches[0].start + 1 : 1;
    hits.push(SearchHitSchema.parse({ file: path, line, col, text }));
  }
  return hits;
}

interface RgMatchEvent {
  type: 'match';
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: Array<{ start: number; end: number }>;
  };
}

function isMatchEvent(event: unknown): event is RgMatchEvent {
  if (typeof event !== 'object' || event === null) return false;
  const e = event as { type?: unknown; data?: unknown };
  if (e.type !== 'match' || typeof e.data !== 'object' || e.data === null) return false;
  const d = e.data as {
    path?: unknown;
    lines?: unknown;
    line_number?: unknown;
    submatches?: unknown;
  };
  if (
    typeof d.path !== 'object' ||
    d.path === null ||
    typeof (d.path as { text?: unknown }).text !== 'string'
  ) {
    return false;
  }
  if (
    typeof d.lines !== 'object' ||
    d.lines === null ||
    typeof (d.lines as { text?: unknown }).text !== 'string'
  ) {
    return false;
  }
  if (typeof d.line_number !== 'number' || !Array.isArray(d.submatches)) return false;
  return true;
}

const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
]);

export async function runTree(rootPath: string, opts: TreeOpts = {}): Promise<TreeEntry[]> {
  const cwd = opts.cwd ?? process.cwd();
  const depth = opts.depth ?? 1;
  if (depth < 1) {
    throw new ContextError('depth must be >= 1');
  }
  const absRoot = resolve(cwd, rootPath);

  let rootStat: Awaited<ReturnType<typeof stat>>;
  try {
    rootStat = await stat(absRoot);
  } catch (err: unknown) {
    if (err instanceof Error && /ENOENT/.test(err.message)) {
      throw new ContextError(`path not found: ${rootPath}`);
    }
    throw err;
  }
  if (!rootStat.isDirectory()) {
    throw new ContextError(`not a directory: ${rootPath}`);
  }

  const entries: TreeEntry[] = [];
  await walk(absRoot, cwd, depth, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

async function walk(dir: string, cwd: string, depth: number, out: TreeEntry[]): Promise<void> {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const ent of dirents) {
    if (DEFAULT_IGNORES.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    const rel = relative(cwd, abs) || ent.name;
    if (ent.isDirectory()) {
      out.push(TreeEntrySchema.parse({ path: rel, kind: 'dir' }));
      if (depth > 1) {
        await walk(abs, cwd, depth - 1, out);
      }
    } else if (ent.isFile()) {
      const s = await stat(abs);
      out.push(TreeEntrySchema.parse({ path: rel, kind: 'file', size: s.size }));
    }
  }
}

export function formatSearchText(hits: readonly SearchHit[]): string {
  return hits.map((h) => `${h.file}:${h.line}:${h.col}: ${h.text}`).join('\n');
}

export function formatTreeText(entries: readonly TreeEntry[]): string {
  return entries
    .map((e) => (e.kind === 'dir' ? `${e.path}/` : `${e.path}\t${e.size ?? 0}`))
    .join('\n');
}
