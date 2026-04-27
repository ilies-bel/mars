import { git, gitOrThrow } from './git.ts';
import type { CheckpointInput, CheckpointResult } from './types.ts';
import { worktreeBranch } from './worktree.ts';

function formatCommitMessage(hint: string, taskId: string): string {
  const trimmed = hint.trim();
  return trimmed ? `mars: ${trimmed} [task ${taskId}]` : `mars: checkpoint task ${taskId}`;
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const r = await gitOrThrow(['status', '--porcelain'], { cwd: worktreePath });
  return r.stdout.trim().length > 0;
}

async function getHead(cwd: string): Promise<string> {
  const r = await gitOrThrow(['rev-parse', 'HEAD'], { cwd });
  return r.stdout.trim();
}

async function listConflictedFiles(repoRoot: string): Promise<string[]> {
  const r = await gitOrThrow(['diff', '--name-only', '--diff-filter=U'], { cwd: repoRoot });
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function checkpoint(
  repoRoot: string,
  input: CheckpointInput,
): Promise<CheckpointResult> {
  const { worktreePath, hint, taskId } = input;
  const branch = worktreeBranch(extractHandleId(worktreePath));
  const message = formatCommitMessage(hint, taskId);

  const dirty = await isWorktreeDirty(worktreePath);
  if (!dirty) {
    return { ref: await getHead(repoRoot), noop: true };
  }

  await gitOrThrow(['add', '-A'], { cwd: worktreePath });
  await gitOrThrow(['commit', '-m', message], { cwd: worktreePath });

  const merge = await git(['merge', '--no-ff', '-m', message, branch], { cwd: repoRoot });
  if (merge.exitCode !== 0) {
    const files = await listConflictedFiles(repoRoot);
    await gitOrThrow(['merge', '--abort'], { cwd: repoRoot }).catch(() => {
      // already aborted or nothing to abort; not fatal.
    });
    return {
      conflict: {
        files,
        description: merge.stderr.trim() || `merge of ${branch} into HEAD failed`,
      },
    };
  }

  return { ref: await getHead(repoRoot) };
}

function extractHandleId(worktreePath: string): string {
  const last = worktreePath.split('/').filter(Boolean).pop();
  if (!last) {
    throw new Error(`cannot extract handleId from worktree path: ${worktreePath}`);
  }
  return last;
}
