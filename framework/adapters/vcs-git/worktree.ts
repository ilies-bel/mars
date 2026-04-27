import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gitOrThrow } from './git.ts';

export const WORKTREES_DIR = '.mars/worktrees';
export const BRANCH_PREFIX = 'mars/';

function pathFor(repoRoot: string, handleId: string): string {
  return resolve(repoRoot, WORKTREES_DIR, handleId);
}

function branchFor(handleId: string): string {
  return `${BRANCH_PREFIX}${handleId}`;
}

export async function createWorktree(repoRoot: string, handleId: string): Promise<string> {
  const path = pathFor(repoRoot, handleId);
  const branch = branchFor(handleId);
  await mkdir(dirname(path), { recursive: true });
  await gitOrThrow(['worktree', 'add', '-b', branch, path, 'HEAD'], { cwd: repoRoot });
  return path;
}

export async function removeWorktree(repoRoot: string, handleId: string): Promise<void> {
  const path = pathFor(repoRoot, handleId);
  const branch = branchFor(handleId);
  await gitOrThrow(['worktree', 'remove', '--force', path], { cwd: repoRoot }).catch(async () => {
    await rm(path, { recursive: true, force: true });
    await gitOrThrow(['worktree', 'prune'], { cwd: repoRoot });
  });
  await gitOrThrow(['branch', '-D', branch], { cwd: repoRoot }).catch(() => {
    // branch may already be gone (e.g. test cleanup retry); not fatal.
  });
}

export function worktreePath(repoRoot: string, handleId: string): string {
  return pathFor(repoRoot, handleId);
}

export function worktreeBranch(handleId: string): string {
  return branchFor(handleId);
}
