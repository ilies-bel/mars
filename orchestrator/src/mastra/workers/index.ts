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
  'Bash(mars proposal*)',
  'Bash(mars draft*)',
] as const

export type WorkerName = 'Coder' | 'Planner' | 'Slicer' | 'Triager' | 'Fixer'

// Execution runtime for a Worker. 'headless' is the current default and only
// supported value — the Worker runs via `claude -p` in a non-interactive
// subprocess. Future values (e.g. 'tmux') are reserved for later PRDs; no
// dispatch logic branches on this field yet.
export type WorkerRuntime = 'headless'

export type ClaudeOutputFormat = 'stream-json' | 'json' | 'text'

// Pinned configuration for a Worker. Everything here is fixed at registration
// time; per-invocation values (cwd, prompt, sessionId, onEvent) are passed to
// run().
//
// This interface is the single auditable contract: every field a dispatched
// `claude -p` invocation can be configured with appears here. A workflow
// author who reads WORKER_CONFIGS sees the entire role-pinned posture
// (model, fallback model, effort, permission mode, agent, system prompt
// shape, allow/deny lists, tool list, output format, message cap, bare
// mode) without having to chase the dispatch call site.
//
// `systemPrompt` and `appendSystemPrompt` are mutually exclusive. The
// Worker factory throws at construction time if both are pinned — the
// underlying `claude -p` flags `--system-prompt` and
// `--append-system-prompt` cannot both be set on one invocation.
export interface WorkerConfig {
  readonly name: WorkerName
  readonly model: string
  // Optional fallback model. Reserved for the dispatch wrapper to use when
  // the primary model is unavailable / overloaded. Pinned per Worker so the
  // operator audits which fallback applies per stage.
  readonly fallbackModel?: string
  readonly effort: ClaudeEffort
  readonly permissionMode: ClaudePermissionMode
  readonly bare: boolean
  // Pinned --agent value for this Worker, if any. Optional — most Workers
  // run with the default agent.
  readonly agent?: string
  // Replaces the default composed system prompt at dispatch time. Mutually
  // exclusive with `appendSystemPrompt`.
  readonly systemPrompt?: string
  // Appended to the default composed system prompt at dispatch time.
  // Mutually exclusive with `systemPrompt`.
  readonly appendSystemPrompt?: string
  // Tools explicitly allowed for this Worker. The dispatch wrapper passes
  // these as `--allowedTools`; absence means no allow-list filtering.
  readonly allowedTools?: readonly string[]
  readonly disallowedTools: readonly string[]
  // Pinned tool list (mapped to claude's `--tools` flag if present). Most
  // Workers leave this undefined and rely on the default tool surface;
  // tightly-scoped roles may pin a narrow list.
  readonly tools?: readonly string[]
  // Wire format for claude -p's streamed output. Defaults to stream-json
  // (the only format the orchestrator's event reader currently parses).
  readonly outputFormat: ClaudeOutputFormat
  // Per-Worker message cap. Resolved at construction time: explicit override,
  // else DEFAULT_MAX_MESSAGES (0 = unbounded).
  readonly maxMessages: number
  // Execution runtime for this Worker. Always 'headless' for existing Workers —
  // dispatched via `claude -p` in a non-interactive subprocess. Reserved for
  // future runtimes (e.g. 'tmux'); no dispatch logic branches on this field yet.
  readonly runtime: WorkerRuntime
}

// Public default for the message-cap cascade. Matches the wrapper's
// DEFAULT_CLAUDE_MAX_MESSAGES so the registry stays consistent with
// runClaudeCode's per-invocation fallback. 0 = unbounded: the 100 default was
// cutting Coders off mid-implementation. Workers that need a hard ceiling set
// one explicitly (e.g. Triager=40).
export const DEFAULT_MAX_MESSAGES = 0

// Resolve a Worker's effective message cap: returns the explicit override when
// it is a non-negative integer, otherwise DEFAULT_MAX_MESSAGES (0 = unbounded).
export const resolveWorkerMaxMessages = (override?: number): number => {
  if (override !== undefined && Number.isInteger(override) && override >= 0) {
    return override
  }
  return DEFAULT_MAX_MESSAGES
}

export interface RunOptions {
  readonly cwd: string
  readonly sessionId?: string
  readonly onEvent?: (event: ClaudeEvent) => void | Promise<void>
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
  readonly runtime: WorkerRuntime
  run(prompt: string, options: RunOptions): Promise<RunClaudeResult>
}

const CLAUDE_OPUS_MODEL = 'claude-opus-4-7'
const CLAUDE_SONNET_MODEL = 'claude-sonnet-4-6'

// Resolve the effective model for the Coder Worker. When `MARS_WORKER_MODEL`
// is set, it overrides the pinned default — useful for one-off sessions that
// need Opus reasoning (e.g. a complex architectural migration) without editing
// code. The env var is read at process start and affects every Coder run for
// the lifetime of that daemon process; there is no per-task override.
// Planner/Slicer/Fixer are NOT affected — they always use their pinned model
// for cost/safety reasons.
export const CODER_MODEL: string =
  process.env.MARS_WORKER_MODEL ?? CLAUDE_SONNET_MODEL

// Day-one defaults agreed in the grill for PRD 948691d0. The Coder runs on
// sonnet / high effort / bypassPermissions with the full tool surface (no
// per-Worker disallows beyond the wrapper-layer agent-to-user ban). Fixer
// mirrors Coder's effort and permission posture but intentionally stays on
// Opus — recovery tasks deal with broken or partially-applied code where
// Sonnet may miss corner cases. Fixer also layers backlog-mutation denials so
// a no-commit Session cannot refile its task as a loose end.
// Planner, Slicer, and Triager are read-only synthesis stages: default
// permissions, Edit/Write/NotebookEdit denied. Triager additionally pins a
// 40-message cap (sonnet / medium effort). Bare mode is disabled because
// the locally installed claude CLI 2.1.142 fails authentication when --bare
// is set (returns "Not logged in") even though keychain auth is valid in
// non-bare invocations.
export const WORKER_CONFIGS: Readonly<Record<WorkerName, WorkerConfig>> = {
  Coder: {
    name: 'Coder',
    model: CODER_MODEL,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    disallowedTools: [],
    outputFormat: 'stream-json',
    maxMessages: resolveWorkerMaxMessages(),
    runtime: 'headless',
  },
  Planner: {
    name: 'Planner',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'default',
    bare: false,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxMessages: resolveWorkerMaxMessages(),
    runtime: 'headless',
  },
  Slicer: {
    name: 'Slicer',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'default',
    bare: false,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    // Slicing is a read-heavy, one-shot analysis of a whole PRD against the
    // codebase; the 100-message default (shared with Coder/Planner) is too
    // tight — the slicer spends 60+ messages orienting and was SIGKILLed
    // before it could emit the slice JSON. 250 gives ~4x headroom while
    // keeping a hard ceiling so a looping slicer can't burn unbounded tokens.
    maxMessages: resolveWorkerMaxMessages(250),
    runtime: 'headless',
  },
  Triager: {
    name: 'Triager',
    model: CLAUDE_SONNET_MODEL,
    effort: 'medium',
    permissionMode: 'default',
    bare: false,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxMessages: resolveWorkerMaxMessages(40),
    runtime: 'headless',
  },
  Fixer: {
    name: 'Fixer',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    disallowedTools: FIXER_BACKLOG_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxMessages: resolveWorkerMaxMessages(),
    runtime: 'headless',
  },
} as const

// Construction-time guard. `claude -p` cannot accept both --system-prompt
// and --append-system-prompt on the same invocation, and silently letting
// a Worker pin both would mean one is dropped at dispatch with no audit
// trail. Throwing at module-load surfaces the misconfiguration where the
// operator can fix it.
const assertSystemPromptShape = (config: WorkerConfig): void => {
  if (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined) {
    throw new Error(
      `Worker ${config.name}: systemPrompt and appendSystemPrompt are mutually exclusive — set exactly one.`,
    )
  }
}

// Public factory. Constructing a Worker through this path enforces the
// systemPrompt-vs-appendSystemPrompt mutual exclusion and produces a Worker
// whose run() delegates to the dispatch wrapper with the pinned config.
// Exported so tests (and future Worker-derived shapes — experimentation
// harnesses, ad-hoc one-off runners) can construct Workers with the same
// guarantees as the shipped registry.
export const createWorker = (config: WorkerConfig): Worker => buildWorker(config)

const buildWorker = (config: WorkerConfig): Worker => {
  assertSystemPromptShape(config)
  return {
    config,
    runtime: config.runtime,
    run: (prompt, options) =>
      runClaudeCode({
        cwd: options.cwd,
        prompt,
        model: config.model,
        systemPrompt: options.systemPrompt ?? config.systemPrompt ?? config.appendSystemPrompt,
        sessionId: options.sessionId,
        onEvent: options.onEvent,
        effort: config.effort,
        permissionMode: config.permissionMode,
        bare: config.bare,
        agent: config.agent,
        disallowedTools: config.disallowedTools,
        maxMessages: config.maxMessages,
        externalAbort: options.externalAbort,
      }),
  }
}

export const Workers: Readonly<Record<WorkerName, Worker>> = {
  Coder: buildWorker(WORKER_CONFIGS.Coder),
  Planner: buildWorker(WORKER_CONFIGS.Planner),
  Slicer: buildWorker(WORKER_CONFIGS.Slicer),
  Triager: buildWorker(WORKER_CONFIGS.Triager),
  Fixer: buildWorker(WORKER_CONFIGS.Fixer),
} as const

export const getWorker = (name: WorkerName): Worker => Workers[name]

// Single, audited mapping from a Task's tag to the Worker that implements it.
// The structured-write accommodation lane (tag='writer' → Writer Worker) was
// removed by ADR 0019; 'coder' is now the only valid tag and every tag
// resolves to the default Coder Worker. The seam is preserved so future tags
// can be added by extending TaskTag and adding a row here.
const TAG_TO_WORKER: Readonly<Record<TaskTag, WorkerName>> = {
  coder: 'Coder',
} as const

export const getWorkerForTag = (tag: TaskTag): Worker =>
  Workers[TAG_TO_WORKER[tag]]
