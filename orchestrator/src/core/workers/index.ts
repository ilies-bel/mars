// Worker registry — one auditable location for the per-stage pinned
// `claude -p` configuration. Each named Worker bundles the model, effort,
// permission posture, bare mode, and denied tools that the stage runs
// under. Workflow authors call `worker.run(prompt, { cwd, ... })`
// instead of assembling claude flags ad-hoc.
//
// The agent-to-user denial (AskUserQuestion + SendUserMessage) is enforced at
// the runClaudeCode wrapper layer (see ../lib/git/claude.ts:AGENT_TO_USER_DENIED_TOOLS).
// Any extra Worker-level `disallowedTools` here are unioned on top — they
// cannot remove the agent-to-user denial.
//
// See PRD 948691d0-stop-dispatched-implement-workers-from-c.

import {
  runClaudeCode,
  type ClaudeEffort,
  type ClaudePermissionMode,
  type RunClaudeResult,
} from '../lib/git/claude'
import type { ClaudeEvent } from '../lib/claude-stream'
import type { ProviderName } from './providers'
import { PROVIDERS } from './providers'
import { runPtySession } from './run-pty-session'

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

export type WorkerName =
  | 'Coder'
  | 'Planner'
  | 'Slicer'
  | 'Triager'
  | 'Fixer'
  | 'BehaviourVerifier'
  | 'Scorer'

// Execution runtime for a Worker. 'headless' runs via `claude -p` in a
// non-interactive subprocess (current default for all built-in Workers).
// 'pty' drives the agent under node-pty — non-attachable (no operator terminal
// access; the operator reads traces/logs after the fact). No dispatch logic
// branches on this field yet.
export type WorkerRuntime = 'headless' | 'pty'

export type ClaudeOutputFormat = 'stream-json' | 'json' | 'text'

// Pinned configuration for a Worker. Everything here is fixed at registration
// time; per-invocation values (cwd, prompt, sessionId, onEvent) are passed to
// run().
//
// This interface is the single auditable contract: every field a dispatched
// `claude -p` invocation can be configured with appears here. A workflow
// author who reads WORKER_CONFIGS sees the entire role-pinned posture
// (model, fallback model, effort, permission mode, agent, system prompt
// shape, allow/deny lists, tool list, output format, bare mode) without
// having to chase the dispatch call site.
//
// `systemPrompt` and `appendSystemPrompt` are mutually exclusive. The
// Worker factory throws at construction time if both are pinned — the
// underlying `claude -p` flags `--system-prompt` and
// `--append-system-prompt` cannot both be set on one invocation.
export interface WorkerConfig {
  readonly name: string
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
  // Per-Worker context token budget. Compared against the LATEST assistant
  // event's input-side token count (input + cache_read + cache_creation) on
  // each turn; 0 = disabled. Set intentionally below the model's real context
  // window to kill a run before Claude Code auto-compacts. A compression-
  // induced kill is treated as a FAILURE (reason: context-exhausted) and
  // routed through the normal recovery flow.
  readonly maxContextTokens: number
  // Execution runtime for this Worker. All built-in Workers use 'headless'
  // (dispatched via `claude -p` in a non-interactive subprocess). 'pty' is the
  // node-pty harness — non-attachable; the operator reads traces/logs after the
  // fact. No dispatch logic branches on this field yet.
  readonly runtime: WorkerRuntime
  // Agent CLI Provider that drives this Worker. Names an entry in the PROVIDERS
  // registry (currently only 'claude'). Dispatch behaviour is unchanged — the
  // field is read but not yet branched on; future slices will wire it up.
  readonly provider: ProviderName
  // Tags this Worker handles. pickWorkerForTags returns this Worker when the
  // task's tag list intersects this set. Workers with no tags entry are never
  // selected by tag (they are dispatched by kind or as the fallback).
  readonly tags?: readonly string[]
  // Extra MCP server entries pinned for this Worker, merged into the inline
  // `--mcp-config` JSON on top of the always-injected codegraph server (see
  // claudeStreamArgs' --mcp-config/--strict-mcp-config injection point in
  // ../lib/git/claude.ts). Keyed by server name; values follow the
  // `mcpServers` entry shape ({ type: 'stdio', command, args }). A worker
  // MAY pin extra MCP servers the operator has already provisioned in their
  // environment — the framework never installs or spawns servers itself.
  // Headless runtime only — the pty path does not thread it.
  readonly mcpConfig?: Readonly<Record<string, unknown>>
  readonly safeMode?: boolean
}

// Resolve a Worker's effective context token budget. The env var
// MARS_CONTEXT_TOKEN_BUDGET globally overrides all per-worker defaults
// (useful to tighten or loosen the budget at runtime without editing code).
// Returns 0 (disabled) when neither the env var nor the override is positive.
export const resolveWorkerMaxContextTokens = (override?: number): number => {
  const fromEnv = parseInt(process.env.MARS_CONTEXT_TOKEN_BUDGET ?? '0', 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  if (override !== undefined && Number.isInteger(override) && override > 0) {
    return override
  }
  return 0
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
const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5-20251001'

// codegraph nudge appended to the system prompt of the workers that benefit
// most from the pre-indexed code knowledge graph (Planner, Slicer, Coder).
// The codegraph MCP server is registered in the repo-root `.mcp.json`, so the
// `codegraph_*` tools are available to every dispatched `claude -p` run that
// reads project MCP config (which they all do — see claudeStreamArgs'
// --strict-mcp-config + --setting-sources project,local). The nudge steers the
// worker toward the graph before it falls back to broad file-scanning, which
// is what cuts tool calls and context churn.
// Exported so tests can pin the exact blast radius (which Workers carry the
// nudge) and detect unintended additions or removals.
export const CODEGRAPH_NUDGE =
  'Before broad file-scanning (rg/fd/Glob across the tree), consult the `codegraph` CLI to locate symbols, trace call graphs, and assess blast radius — it is faster and cheaper than reading files to reconstruct structure. Key commands:\n\n  codegraph query <SymbolName>          # locate a symbol definition\n  codegraph callees <functionName>      # trace what a function calls\n  codegraph callers <symbolName>        # who calls this symbol\n  codegraph impact <symbolName>         # change-impact analysis\n\nFall back to rg/fd+Read when codegraph is not on PATH or lacks the detail you need.'

// Resolve the effective model for the Coder Worker. When `MARS_WORKER_MODEL`
// is set, it overrides the pinned default — useful for one-off sessions that
// need Opus reasoning (e.g. a complex architectural migration) without editing
// code. The env var is read at process start and affects every Coder run for
// the lifetime of that daemon process; there is no per-task override.
// Planner/Slicer are NOT affected — they always use their pinned Opus model
// for cost/safety reasons. Fixer uses Sonnet (same as Coder) because recovery
// briefs are scoped mechanical work, not architectural reasoning.
export const CODER_MODEL: string =
  process.env.MARS_WORKER_MODEL ?? CLAUDE_SONNET_MODEL

// Day-one defaults agreed in the grill for PRD 948691d0. The Coder runs on
// sonnet / high effort / bypassPermissions with the full tool surface (no
// per-Worker disallows beyond the wrapper-layer agent-to-user ban). Fixer
// mirrors Coder's effort, permission posture, and model (Sonnet) — recovery
// briefs are scoped mechanical work (finish-the-job or repair-one-defect) that
// Sonnet handles well; Opus pinning was a cost amplifier under failure storms.
// Fixer also layers backlog-mutation denials so a no-commit Session cannot
// refile its task as a loose end.
// Planner, Slicer, and Triager are read-only synthesis stages: default
// permissions, Edit/Write/NotebookEdit denied. Triager runs on sonnet /
// medium effort. Bare mode is disabled because
// the locally installed claude CLI 2.1.142 fails authentication when --bare
// is set (returns "Not logged in") even though keychain auth is valid in
// non-bare invocations.
// Per-worker context token budgets. These are intentionally below the model's
// real context window (200k tokens for Claude Sonnet/Opus) to kill a run
// before Claude Code would auto-compact. The 80% warn fires at 144k tokens
// (well inside the window); the kill fires at 180k — leaving 20k of headroom
// before the model's 200k limit so compaction never gets a chance to trigger.
// Triager gets a tighter budget (50k) as a belt-and-suspenders guard given its
// focused read-only synthesis role.
const CODER_CONTEXT_TOKENS = resolveWorkerMaxContextTokens(180_000)
const GENEROUS_CONTEXT_TOKENS = resolveWorkerMaxContextTokens(180_000)
const TRIAGER_CONTEXT_TOKENS = resolveWorkerMaxContextTokens(50_000)

export const WORKER_CONFIGS: Readonly<Record<WorkerName, WorkerConfig>> = {
  Coder: {
    name: 'Coder',
    model: CODER_MODEL,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    safeMode: true,
    appendSystemPrompt: CODEGRAPH_NUDGE,
    disallowedTools: [],
    outputFormat: 'stream-json',
    maxContextTokens: CODER_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: 'claude',
    tags: ['coder'],
  },
  Planner: {
    name: 'Planner',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'default',
    bare: false,
    appendSystemPrompt: CODEGRAPH_NUDGE,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: GENEROUS_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: 'claude',
    tags: ['planner'],
  },
  Slicer: {
    name: 'Slicer',
    model: CLAUDE_OPUS_MODEL,
    effort: 'high',
    permissionMode: 'default',
    bare: false,
    appendSystemPrompt: CODEGRAPH_NUDGE,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: GENEROUS_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: 'claude',
    tags: ['slicer'],
  },
  Triager: {
    name: 'Triager',
    model: CLAUDE_SONNET_MODEL,
    effort: 'medium',
    permissionMode: 'default',
    bare: false,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: TRIAGER_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: 'claude',
    tags: ['triager'],
  },
  Fixer: {
    name: 'Fixer',
    model: CLAUDE_SONNET_MODEL,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    safeMode: true,
    disallowedTools: FIXER_BACKLOG_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: GENEROUS_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: 'claude',
    tags: ['fixer'],
  },
  // Behaviour-verify Worker: exercises the live dev server booted by the
  // behaviour-verify step and emits per-criterion verdict JSON. Uses whatever
  // browser/UI-driving MCP tools the operator has wired into their Claude Code
  // environment; if none are present, the worker marks all criteria
  // 'unverifiable' and the CAN'T-VERIFY path fires — merge still proceeds.
  // Read-only tool surface — it can observe and report but never "fix" the
  // surface to make a criterion pass. bypassPermissions is required so
  // headless MCP tool calls do not stall on a permission prompt no human is
  // listening to; the read-only denial list is the actual safety boundary.
  // A worker MAY pin extra MCP servers via WorkerConfig.mcpConfig when the
  // operator has provisioned them; this worker carries none by default.
  BehaviourVerifier: {
    name: 'BehaviourVerifier',
    model: CLAUDE_SONNET_MODEL,
    effort: 'medium',
    permissionMode: 'bypassPermissions',
    bare: false,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: resolveWorkerMaxContextTokens(100_000),
    runtime: 'headless',
    provider: 'claude',
    tags: ['behaviour-verifier'],
  },
  // Scorer Worker (PRD 6cf85bc9): the record-only post-instance quality judge.
  // Grades a completed Workflow instance's PERSISTED artifacts (composed
  // prompt + merged diff + verify output, all embedded in the dispatch
  // prompt) against an accepted Scorer's rubric and emits a continuous 0..1
  // score plus a one-line rationale. Read-only tool surface — its sole job is
  // to read the prompt and emit the verdict JSON; it must never "fix" the
  // instance to raise a score. Pinned Haiku-class model with a tight context
  // budget: every scored instance adds exactly one judge call, so the model
  // is the cheapest tier and is deliberately NOT overridable via
  // MARS_WORKER_MODEL (only Coder is).
  Scorer: {
    name: 'Scorer',
    model: CLAUDE_HAIKU_MODEL,
    effort: 'medium',
    permissionMode: 'default',
    bare: false,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: resolveWorkerMaxContextTokens(50_000),
    runtime: 'headless',
    provider: 'claude',
    tags: ['scorer'],
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
      config.runtime === 'pty'
        ? runPtySession({
            provider: PROVIDERS[config.provider],
            prompt,
            cwd: options.cwd,
            sessionId: options.sessionId,
            externalAbort: options.externalAbort,
            model: config.model,
            onEvent: options.onEvent,
            maxContextTokens: config.maxContextTokens,
            permissionMode: config.permissionMode,
            effort: config.effort,
            disallowedTools: config.disallowedTools,
            agent: config.agent,
            appendSystemPrompt: config.appendSystemPrompt,
            safeMode: config.safeMode,
          })
        : runClaudeCode({
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
            maxContextTokens: config.maxContextTokens,
            mcpServers: config.mcpConfig,
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
  BehaviourVerifier: buildWorker(WORKER_CONFIGS.BehaviourVerifier),
  Scorer: buildWorker(WORKER_CONFIGS.Scorer),
} as const

export const getWorker = (name: WorkerName): Worker => Workers[name]

/**
 * Select a Worker for a task based on tag intersection.
 *
 * Iterates through the registered Workers and returns the first one whose
 * `config.tags` set intersects with the task's tag list. When no Worker
 * claims any of the task's tags, the function falls through to the
 * **default headless Worker** — the Coder, running via `claude -p` with
 * full tool surface and bypassPermissions. This fallback guarantees every
 * task gets a runner even when no tag-specific Worker is registered.
 *
 * Accepts a `Record<string, Worker>` so operator-declared Workers from the
 * persisted registry can be included alongside the built-in Workers. The
 * caller merges `Workers` (built-in) with any registry-declared instances
 * before calling; the first matching Worker in iteration order wins.
 */
export const pickWorkerForTags = (
  tags: readonly string[],
  workers: Readonly<Record<string, Worker>>,
): Worker => {
  for (const worker of Object.values(workers)) {
    if (worker.config.tags?.some((t) => tags.includes(t))) {
      return worker
    }
  }
  // Default headless Worker: the Coder, with full tool surface and
  // bypassPermissions. Every task that carries no tag matching a registered
  // Worker falls back here — no task is left without a runner.
  return workers['Coder'] ?? Workers.Coder
}
