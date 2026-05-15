// Worker registry — one auditable location for the per-stage pinned
// `claude -p` configuration. Each named Worker bundles the model, effort,
// permission posture, bare mode, denied tools, and message cap that the
// stage runs under. Workflow authors call `worker.run(prompt, { cwd, ... })`
// instead of assembling claude flags ad-hoc.
//
// The agent-to-user denial (AskUserQuestion + SendUserMessage) is enforced at
// the runClaudeCode wrapper layer (see ../lib/git.ts:AGENT_TO_USER_DENIED_TOOLS).
// Any extra Worker-level `disallowedTools` here are unioned on top — they
// cannot remove the agent-to-user denial.
//
// See PRD 948691d0-stop-dispatched-implement-workers-from-c.

import {
  runClaudeCode,
  type ClaudeEffort,
  type ClaudePermissionMode,
  type RunClaudeResult,
} from '../lib/git'
import type { ClaudeEvent } from '../lib/claude-stream'
import type { TaskTag } from '../queue'

// Mutation tools denied for read-only Workers (Planner, Slicer, Triager).
// A confused agent dispatched into one of those stages cannot silently mutate
// the worktree — its sole job is to read and emit text.
export const READ_ONLY_DENIED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
] as const

// Backlog-mutation denial set for Fixer: a fix-task Session that cannot
// complete its recovery must not be able to refile its failing task as a
// fresh loose end. Omitting the enqueue-task Mastra tool is the primary
// guard; these Bash patterns block the CLI escape hatch. See slice 5/8.
export const FIXER_BACKLOG_DENIED_TOOLS: readonly string[] = [
  'Bash(mars task add*)',
  'Bash(mars idea*)',
  'Bash(mars draft*)',
] as const

// Writer worktree-edit denial set. The Writer Worker lands glossary and ADR
// changes through the daemon's structured-write verbs (`mars glossary
// set/remove`, `mars adr add`). Direct edits to `CONTEXT.md` or `docs/adr/**`
// from a coding worktree are forbidden by CLAUDE.md; denying the in-worktree
// editors leaves the daemon verbs as the only way for a Writer to land
// documentation, which is exactly what the routing is for.
export const WRITER_DENIED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
] as const

export type WorkerName = 'Coder' | 'Planner' | 'Slicer' | 'Triager' | 'Fixer' | 'Writer'

// Pinned configuration for a Worker. Everything here is fixed at registration
// time; per-invocation values (cwd, prompt, sessionId, onEvent) are passed to
// run().
export interface WorkerConfig {
  readonly name: WorkerName
  readonly model: string
  readonly effort: ClaudeEffort
  readonly permissionMode: ClaudePermissionMode
  readonly bare: boolean
  readonly disallowedTools: readonly string[]
  // Default per-invocation timeout (ms). Workflow authors may override with
  // RunOptions.timeoutMs but the default is pinned here so a stage cannot
  // forget to set one.
  readonly defaultTimeoutMs: number
  // Per-Worker message cap. Triager pins 40 so a stuck triage fails fast
  // instead of spinning to the global default of 100.
  readonly maxMessages: number
}

export interface RunOptions {
  readonly cwd: string
  readonly sessionId?: string
  readonly onEvent?: (event: ClaudeEvent) => void | Promise<void>
  readonly timeoutMs?: number
  readonly systemPrompt?: string
  /**
   * Caller-supplied abort signal. Forwarded to {@link runClaudeCode} so the
   * read/grep span watcher can terminate a stalled session. When fired the
   * Worker returns exitCode 138.
   */
  readonly externalAbort?: AbortSignal
}

export interface Worker {
  readonly config: WorkerConfig
  run(prompt: string, options: RunOptions): Promise<RunClaudeResult>
}

const CLAUDE_OPUS_MODEL = 'claude-opus-4-7'
const CLAUDE_SONNET_MODEL = 'claude-sonnet-4-6'
const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5-20251001'

// Day-one defaults agreed in the grill for PRD 948691d0. The Coder runs on
// opus / high effort / bypassPermissions with the full tool surface (no
// per-Worker disallows beyond the wrapper-layer agent-to-user ban). Fixer
// shares Coder's model and permission posture but layers backlog-mutation
// denials so a no-commit Fixer Session cannot refile its task as a loose end.
// Planner, Slicer, and Triager are read-only synthesis stages: default
// permissions, bare mode for cache reuse, Edit/Write/NotebookEdit denied.
// Triager additionally pins a 40-message cap (sonnet / medium effort).
export const WORKER_CONFIGS: Readonly<Record<WorkerName, WorkerConfig>> = {
  Coder: {
    name: 'Coder',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    disallowedTools: [],
    defaultTimeoutMs: 20 * 60 * 1000,
    maxMessages: 100,
  },
  Planner: {
    name: 'Planner',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'default',
    bare: true,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    defaultTimeoutMs: 5 * 60 * 1000,
    maxMessages: 100,
  },
  Slicer: {
    name: 'Slicer',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'default',
    bare: true,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    defaultTimeoutMs: 5 * 60 * 1000,
    maxMessages: 100,
  },
  Triager: {
    name: 'Triager',
    model: CLAUDE_SONNET_MODEL,
    effort: 'medium',
    permissionMode: 'default',
    bare: true,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    defaultTimeoutMs: 2 * 60 * 1000,
    maxMessages: 40,
  },
  Fixer: {
    name: 'Fixer',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    disallowedTools: FIXER_BACKLOG_DENIED_TOOLS,
    defaultTimeoutMs: 20 * 60 * 1000,
    maxMessages: 100,
  },
  // Writer lands glossary/ADR slices via the daemon's structured-write verbs
  // rather than direct worktree edits. Haiku is enough for the
  // canonical-one-liner work these slices produce; permissionMode='default'
  // so the wrapper does not pass --dangerously-skip-permissions (the work
  // happens via Bash CLI calls and requires no broad file-edit grant).
  // Edit/Write/NotebookEdit denied so the agent cannot bypass the
  // structured-write seam by editing CONTEXT.md or docs/adr/** in the
  // worktree.
  Writer: {
    name: 'Writer',
    model: CLAUDE_HAIKU_MODEL,
    effort: 'medium',
    permissionMode: 'default',
    bare: false,
    disallowedTools: WRITER_DENIED_TOOLS,
    defaultTimeoutMs: 20 * 60 * 1000,
    maxMessages: 100,
  },
} as const

const buildWorker = (config: WorkerConfig): Worker => ({
  config,
  run: (prompt, options) =>
    runClaudeCode({
      cwd: options.cwd,
      prompt,
      timeoutMs: options.timeoutMs ?? config.defaultTimeoutMs,
      model: config.model,
      systemPrompt: options.systemPrompt,
      sessionId: options.sessionId,
      onEvent: options.onEvent,
      effort: config.effort,
      permissionMode: config.permissionMode,
      bare: config.bare,
      disallowedTools: config.disallowedTools,
      maxMessages: config.maxMessages,
      externalAbort: options.externalAbort,
    }),
})

export const Workers: Readonly<Record<WorkerName, Worker>> = {
  Coder: buildWorker(WORKER_CONFIGS.Coder),
  Planner: buildWorker(WORKER_CONFIGS.Planner),
  Slicer: buildWorker(WORKER_CONFIGS.Slicer),
  Triager: buildWorker(WORKER_CONFIGS.Triager),
  Fixer: buildWorker(WORKER_CONFIGS.Fixer),
  Writer: buildWorker(WORKER_CONFIGS.Writer),
} as const

export const getWorker = (name: WorkerName): Worker => Workers[name]

// Single, audited mapping from a Task's tag to the Worker that implements it.
// Adding a tag here is the only way a new Worker becomes reachable from
// `mars task add --tag`; conversely, removing a mapping rejects every task
// row that names it at dispatch. The implement workflow's run-claude-code
// step calls this to pick a Worker.
const TAG_TO_WORKER: Readonly<Record<TaskTag, WorkerName>> = {
  coder: 'Coder',
  writer: 'Writer',
} as const

export const getWorkerForTag = (tag: TaskTag): Worker =>
  Workers[TAG_TO_WORKER[tag]]
