export type ConflictInfo = {
  files: string[];
  description: string;
};

export type CheckpointResult = { ref: string; noop?: boolean } | { conflict: ConflictInfo };

export type CheckpointInput = {
  worktreePath: string;
  hint: string;
  taskId: string;
};
