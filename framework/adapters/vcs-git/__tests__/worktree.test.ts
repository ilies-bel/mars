import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { gitOrThrow } from '../git.ts';
import { createWorktree, removeWorktree, worktreeBranch, worktreePath } from '../worktree.ts';
import { type Fixture, createRepo } from './repo-fixture.ts';

describe('worktree create/remove', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createRepo();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('creates a worktree at the expected path with a mars/ branch', async () => {
    const path = await createWorktree(fx.root, 'abc12345-test');
    expect(path).toBe(worktreePath(fx.root, 'abc12345-test'));
    expect(existsSync(path)).toBe(true);

    const r = await gitOrThrow(['worktree', 'list', '--porcelain'], { cwd: fx.root });
    expect(r.stdout).toContain(path);
    expect(r.stdout).toContain(`branch refs/heads/${worktreeBranch('abc12345-test')}`);
  });

  it('removes a worktree and its branch', async () => {
    const path = await createWorktree(fx.root, 'abc12345-test');
    await removeWorktree(fx.root, 'abc12345-test');
    expect(existsSync(path)).toBe(false);

    const branches = await gitOrThrow(['branch', '--list', worktreeBranch('abc12345-test')], {
      cwd: fx.root,
    });
    expect(branches.stdout.trim()).toBe('');
  });

  it('removeWorktree is idempotent for cleanup retries', async () => {
    await createWorktree(fx.root, 'abc12345-test');
    await removeWorktree(fx.root, 'abc12345-test');
    await expect(removeWorktree(fx.root, 'abc12345-test')).resolves.toBeUndefined();
  });
});
