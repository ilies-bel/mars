/**
 * Compile-time exhaustive descriptors for every primitive's override bag.
 *
 * Each descriptor object uses `satisfies Record<keyof *Opts, string>` so that
 * adding a new field to a primitive's opts type (e.g. `RunAgentOpts`) without
 * also adding a description here is a **compile error**, not a silent gap.
 * The CLI's `mars workflow show` renders these strings as the parameter surface.
 */

import type {
  SetupWorktreeOpts,
  RunAgentOpts,
  ReviewOpts,
  MergeOpts,
  AwaitHumanOpts,
} from './index'

/** One-line descriptions for every {@link SetupWorktreeOpts} field. */
export const setupWorktreeDescriptors = {
  kind: 'Pipeline kind — "task" (default), "fix" (attaches to origin worktree), or "diagnose".',
  integrationBranch: 'Merge target branch. Defaults to "main".',
  recoveryPayload: 'Serialised recovery payload (tasks.recovery_payload); only used when kind is "fix".',
  fixForTaskId: 'The origin task a recovery recovers (tasks.fix_for_task_id). Default null.',
  taskId: 'Override the task id. Defaults to ctx.runId.',
} satisfies Record<keyof SetupWorktreeOpts, string>

/** One-line descriptions for every {@link RunAgentOpts} field. */
export const runAgentDescriptors = {
  prompt: 'The task prompt fed to the coder. Defaults to ctx.input.prompt.',
  plan: 'Optional plan sections (functional + technical) injected into the composed prompt.',
  tags: 'Routing tags that select the Worker (e.g. ["coder"]). Defaults to ["coder"].',
  kind: 'Pipeline kind — "task" (default), "fix" (routes to Fixer), or "diagnose".',
  spec: 'Structured task spec passed to the coder for acceptance-criteria scaffolding.',
  integrationBranch: 'Merge target branch. Defaults to "main".',
  resumeFromPriorAttempt: 'When true, prepends a resume banner so the coder continues prior work.',
  verifyFailureOutput: 'Recorded verify output supplied to a coder resuming after verification failed.',
  taskId: 'Override the task id. Defaults to ctx.runId.',
  worktree: 'Override the worktree. Defaults to the one stashed by setupWorktree.',
  model: 'Override the model for this step. Precedence: opts > MARS_WORKER_MODEL > Worker default.',
} satisfies Record<keyof RunAgentOpts, string>

/** One-line descriptions for every {@link ReviewOpts} field. */
export const reviewDescriptors = {
  kind: 'Pipeline kind — "task" (default), "fix", or "diagnose" (short-circuits verification).',
  integrationBranch: 'Merge target branch. Defaults to "main".',
  recoveryPayload: 'Serialised recovery payload; skips test/typecheck/lint for main-committer recovery.',
  taskId: 'Override the task id. Defaults to ctx.runId.',
  worktree: 'Override the worktree. Defaults to the one stashed by setupWorktree.',
  reviewType: 'Review type — "auto" (default) runs typecheck/tests/lint; "manual" boots the stack and parks for human QA; "full-review" spawns a review agent and produces a ReviewPacket.',
  guide: 'Step guide for a "manual" step. Displayed in the action-queue row body alongside the preview URL and log path.',
} satisfies Record<keyof ReviewOpts, string>

/** One-line descriptions for every {@link MergeOpts} field. */
export const mergeDescriptors = {
  kind: 'Pipeline kind — "task" (default), "fix", or "diagnose" (removes worktree, marks done).',
  integrationBranch: 'Merge target branch. Defaults to "main".',
  taskId: 'Override the task id. Defaults to ctx.runId.',
  worktree: 'Override the worktree. Defaults to the one stashed by setupWorktree.',
} satisfies Record<keyof MergeOpts, string>

/** One-line descriptions for every {@link AwaitHumanOpts} field. */
export const awaitHumanDescriptors = {
  note: 'Human-readable note shown in the action-queue row body alongside the task id. Default null.',
  taskId: 'Override the task id. Defaults to ctx.runId.',
  previewUrl: 'Preview URL for a manual-QA row. Null when no preview was started.',
  logPath: 'Log file path for the preview process on a manual-QA row. Null when no preview was started.',
} satisfies Record<keyof AwaitHumanOpts, string>

/**
 * All primitive descriptors indexed by primitive name, for generic rendering.
 * Order matches the typical workflow step sequence.
 */
export const PRIMITIVE_DESCRIPTORS: ReadonlyArray<{
  name: string
  descriptors: Record<string, string>
}> = [
  { name: 'setupWorktree', descriptors: setupWorktreeDescriptors },
  { name: 'runAgent', descriptors: runAgentDescriptors },
  { name: 'review', descriptors: reviewDescriptors },
  { name: 'merge', descriptors: mergeDescriptors },
  { name: 'awaitHuman', descriptors: awaitHumanDescriptors },
]
