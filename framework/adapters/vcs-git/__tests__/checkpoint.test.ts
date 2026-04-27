import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkpoint } from '../checkpoint.ts';
import { gitOrThrow } from '../git.ts';
import { createWorktree, removeWorktree } from '../worktree.ts';
import { type Fixture, createRepo, writeAt } from './repo-fixture.ts';

const HANDLE = 'abc12345-test';
const TASK = '7f3a91c2-add-hello';

describe('checkpoint', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createRepo();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('merges a clean change from worktree into main and produces a commit', async () => {
    const wt = await createWorktree(fx.root, HANDLE);
    await writeAt(wt, 'hello.txt', 'hi\n');

    const result = await checkpoint(fx.root, {
      worktreePath: wt,
      hint: 'add hello',
      taskId: TASK,
    });

    expect('ref' in result).toBe(true);
    if ('ref' in result) {
      expect(result.noop).toBeUndefined();
    }
    expect(existsSync(join(fx.root, 'hello.txt'))).toBe(true);
    expect((await readFile(join(fx.root, 'hello.txt'), 'utf8')).trim()).toBe('hi');

    const log = await gitOrThrow(['log', '--pretty=%s', '-2'], { cwd: fx.root });
    expect(log.stdout).toContain(`mars: add hello [task ${TASK}]`);

    await removeWorktree(fx.root, HANDLE);
  });

  it('returns noop when the worktree has no changes', async () => {
    const wt = await createWorktree(fx.root, HANDLE);
    const before = await gitOrThrow(['rev-parse', 'HEAD'], { cwd: fx.root });

    const result = await checkpoint(fx.root, {
      worktreePath: wt,
      hint: '',
      taskId: TASK,
    });

    expect('ref' in result).toBe(true);
    if ('ref' in result) {
      expect(result.noop).toBe(true);
      expect(result.ref).toBe(before.stdout.trim());
    }

    await removeWorktree(fx.root, HANDLE);
  });

  it('uses the fallback message when hint is empty', async () => {
    const wt = await createWorktree(fx.root, HANDLE);
    await writeAt(wt, 'a.txt', 'x');

    await checkpoint(fx.root, { worktreePath: wt, hint: '', taskId: TASK });

    const log = await gitOrThrow(['log', '--pretty=%s', '-1'], { cwd: fx.root });
    expect(log.stdout.trim()).toBe(`mars: checkpoint task ${TASK}`);

    await removeWorktree(fx.root, HANDLE);
  });

  it('returns ConflictInfo when worktree and main edit the same file', async () => {
    const wt = await createWorktree(fx.root, HANDLE);

    await writeAt(wt, 'README.md', '# from worktree\n');
    await writeAt(fx.root, 'README.md', '# from main\n');
    await gitOrThrow(['add', 'README.md'], { cwd: fx.root });
    await gitOrThrow(['commit', '-m', 'main edit'], { cwd: fx.root });

    const result = await checkpoint(fx.root, {
      worktreePath: wt,
      hint: 'try to merge',
      taskId: TASK,
    });

    expect('conflict' in result).toBe(true);
    if ('conflict' in result) {
      expect(result.conflict.files).toContain('README.md');
      expect(result.conflict.description.length).toBeGreaterThan(0);
    }

    const status = await gitOrThrow(['status', '--porcelain'], { cwd: fx.root });
    expect(status.stdout).not.toContain('UU');

    await removeWorktree(fx.root, HANDLE).catch(() => {
      // worktree branch may have a forensic value; ignore failure here.
    });
  });
});
