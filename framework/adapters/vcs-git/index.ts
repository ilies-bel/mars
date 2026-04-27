export { checkpoint } from './checkpoint.ts';
export { GitError } from './git.ts';
export type { CheckpointInput, CheckpointResult, ConflictInfo } from './types.ts';
export {
  createWorktree,
  removeWorktree,
  worktreeBranch,
  worktreePath,
  WORKTREES_DIR,
} from './worktree.ts';
