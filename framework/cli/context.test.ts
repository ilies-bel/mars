import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessResult, SpawnFn } from '../runtime/process.ts';
import { ContextError, runSearch, runTree } from './context.ts';

function fakeSpawn(result: ProcessResult): SpawnFn {
  return async () => result;
}

function rgMatchLine(file: string, lineNum: number, text: string, start = 0): string {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: file },
      lines: { text: `${text}\n` },
      line_number: lineNum,
      submatches: [{ start, end: start + 1 }],
    },
  });
}

describe('runSearch', () => {
  it('parses ripgrep --json match events into SearchHit[]', async () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: { path: { text: 'a.ts' } } }),
      rgMatchLine('a.ts', 12, '  hello world', 2),
      rgMatchLine('b.ts', 3, 'hello again', 0),
      JSON.stringify({ type: 'end' }),
    ].join('\n');
    const hits = await runSearch('hello', {
      spawn: fakeSpawn({ stdout, stderr: '', exitCode: 0 }),
    });
    expect(hits).toEqual([
      { file: 'a.ts', line: 12, col: 3, text: '  hello world' },
      { file: 'b.ts', line: 3, col: 1, text: 'hello again' },
    ]);
  });

  it('returns empty array when ripgrep exits 1 (no matches)', async () => {
    const hits = await runSearch('nothing', {
      spawn: fakeSpawn({ stdout: '', stderr: '', exitCode: 1 }),
    });
    expect(hits).toEqual([]);
  });

  it('rejects empty queries', async () => {
    await expect(
      runSearch('   ', { spawn: fakeSpawn({ stdout: '', stderr: '', exitCode: 0 }) }),
    ).rejects.toBeInstanceOf(ContextError);
  });

  it('throws ContextError with install hint when rg is missing (ENOENT)', async () => {
    const spawn: SpawnFn = async () => {
      throw new Error('spawn rg ENOENT');
    };
    await expect(runSearch('hello', { spawn })).rejects.toMatchObject({
      name: 'ContextError',
      message: expect.stringMatching(/ripgrep.*not found/i),
    });
  });

  it('throws ContextError on unexpected ripgrep failure', async () => {
    await expect(
      runSearch('hello', {
        spawn: fakeSpawn({ stdout: '', stderr: 'boom', exitCode: 2 }),
      }),
    ).rejects.toMatchObject({
      name: 'ContextError',
      message: expect.stringMatching(/ripgrep failed.*exit 2/),
    });
  });
});

describe('runTree', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `mars-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists files and dirs at depth=1', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'b.ts'), 'export const b = 2;\n');
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'c.ts'), 'export const c = 3;\n');

    const entries = await runTree('.', { cwd: dir, depth: 1 });
    const paths = entries.map((e) => `${e.path}:${e.kind}`).sort();
    expect(paths).toEqual(['a.ts:file', 'b.ts:file', 'sub:dir']);
  });

  it('recurses when depth > 1', async () => {
    await writeFile(join(dir, 'a.ts'), 'x');
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'c.ts'), 'x');

    const entries = await runTree('.', { cwd: dir, depth: 2 });
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['a.ts', 'sub', 'sub/c.ts']);
  });

  it('skips default-ignored directories like node_modules and .git', async () => {
    await writeFile(join(dir, 'a.ts'), 'x');
    await mkdir(join(dir, 'node_modules'));
    await writeFile(join(dir, 'node_modules', 'pkg.js'), 'x');
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, '.git', 'HEAD'), 'x');

    const entries = await runTree('.', { cwd: dir, depth: 5 });
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual(['a.ts']);
  });

  it('throws ContextError for missing path', async () => {
    await expect(runTree('does-not-exist', { cwd: dir })).rejects.toBeInstanceOf(ContextError);
  });

  it('throws ContextError when path is a file, not a directory', async () => {
    await writeFile(join(dir, 'a.ts'), 'x');
    await expect(runTree('a.ts', { cwd: dir })).rejects.toMatchObject({
      name: 'ContextError',
      message: expect.stringMatching(/not a directory/),
    });
  });

  it('rejects depth < 1', async () => {
    await expect(runTree('.', { cwd: dir, depth: 0 })).rejects.toBeInstanceOf(ContextError);
  });

  it('returns file sizes', async () => {
    await writeFile(join(dir, 'a.ts'), 'hello');
    const entries = await runTree('.', { cwd: dir, depth: 1 });
    const file = entries.find((e) => e.path === 'a.ts');
    expect(file?.size).toBe(5);
  });
});
