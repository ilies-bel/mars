// Worker registry — one auditable location for per-stage provider-native
// configuration. Each named Worker bundles the model tier, effort,
// permission posture, bare mode, and denied tools that the stage runs
// under. Workflow authors call `worker.run(prompt, { cwd, ... })`
// instead of assembling claude flags ad-hoc.
//
// The agent-to-user denial (AskUserQuestion + SendUserMessage) is enforced at
// the runClaudeCode wrapper layer (see ../lib/git/claude.ts:AGENT_TO_USER_DENIED_TOOLS).
// Those built-in Claude tools are permanently banned. The supported ask-user
// path for Coder/Fixer workers is `Bash(mars task ask <taskId> "<question>")`,
// which emits a `task.question` event that the question-raise outbox subscriber
// converts to a `coder-question` action-queue item the operator resolves.
// Read-only workers carry ASK_USER_DENIED_TOOL in their disallowedTools so they
// cannot raise questions — their role is to read and emit text, never stall on
// operator input.
//
// Any extra Worker-level `disallowedTools` here are unioned on top of the
// wrapper-layer denial — they cannot remove the agent-to-user denial.
//
// See PRD 948691d0-stop-dispatched-implement-workers-from-c.

import {
  type ClaudeEffort,
  type ClaudePermissionMode,
  type RunClaudeResult,
} from '../lib/git/claude'
import type { ClaudeEvent } from '../lib/claude-stream'
import type { ProviderModelTier, ProviderName } from './providers'
import {
  PROVIDERS,
  PROVIDER_MODELS,
  resolveProviderName,
  reportsContextOccupancy,
} from './providers'
import { contextGuardMode } from '../lib/claude-usage'
import { runPtySession } from './run-pty-session'
import {
  RESCUE_OPERATOR_SYSTEM_PROMPT,
  RESCUE_OPERATOR_DENIED_TOOLS,
} from './rescue-operator'

// The bash pattern that invokes the ask-user path. Coder and Fixer workers
// may call `mars task ask <taskId> "<question>"` to surface a question to the
// operator via the action queue (kind='coder-question'). Read-only workers
// carry this in their disallowedTools so they cannot stall on operator input.
export const ASK_USER_DENIED_TOOL = 'Bash(mars task ask*)' as const

// Full built-in tool surface of the agent CLIs the orchestrator dispatches.
// Denying every entry is the ONLY way the provider surface can express "answer
// from the prompt, take no actions" — neither `claude -p` nor `codex exec`
// exposes a first-class no-tools switch (codex's `--sandbox read-only` still
// permits reads, greps, and shell commands). Pinned as an explicit list rather
// than derived so a new built-in tool shows up as a diff here instead of
// silently re-opening the surface.
export const NO_TOOL_USE_DENIED_TOOLS: readonly string[] = [
  'Agent',
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'NotebookEdit',
  'Read',
  'SlashCommand',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
  ASK_USER_DENIED_TOOL,
] as const

// Mutation tools denied for read-only Workers (Planner, Slicer, Triager,
// BehaviourVerifier, Scorer). A confused agent dispatched into one of those
// stages cannot silently mutate the worktree — its sole job is to read and
// emit text. The ask-user denial is included here so read-only workers cannot
// block on operator input either.
export const READ_ONLY_DENIED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  ASK_USER_DENIED_TOOL,
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
  | 'RescueOperator'

// Execution runtime for a Worker. 'headless' runs via the selected provider's
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
// provider invocation can be configured with appears here. A workflow
// author who reads WORKER_CONFIGS sees the entire role-pinned posture
// (model, fallback model, effort, permission mode, agent, system prompt
// shape, allow/deny lists, tool list, output format, bare mode) without
// having to chase the dispatch call site.
//
// `systemPrompt` and `appendSystemPrompt` are mutually exclusive. The
// Worker factory throws at construction time if both are pinned — the
// underlying agent CLI's mutually exclusive system-prompt modes cannot both
// be set on one invocation.
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
  // Normalized wire format for streamed provider output.
  readonly outputFormat: ClaudeOutputFormat
  // Per-Worker context token budget; 0 = disabled. Enforced on two sides:
  //
  //   input — before dispatch, the estimated prompt cost is compared against
  //           this value and an impossible run fails fast
  //           (assertPromptFitsContextBudget). Applies to EVERY provider.
  //   in-run — for a provider that reports context occupancy (see
  //           reportsContextOccupancy) the LATEST assistant event's input-side
  //           token count (input + cache_read + cache_creation) is compared
  //           each turn, warning at 80% and killing at 100%. A provider that
  //           reports only cumulative spend is skipped here: comparing spend
  //           against a window aborts runs nowhere near the limit.
  //
  // Set intentionally below the model's real context window to kill a run
  // before the provider auto-compacts, and above HARNESS_CONTEXT_FLOOR_TOKENS
  // so the budget is reachable at all. A compression-induced kill is treated
  // as a FAILURE (reason: context-exhausted) and routed through the normal
  // recovery flow.
  readonly maxContextTokens: number
  // Execution runtime for this Worker. All built-in Workers use 'headless'
  // (dispatched via the selected CLI in a non-interactive subprocess). 'pty' is the
  // node-pty harness — non-attachable; the operator reads traces/logs after the
  // fact. No dispatch logic branches on this field yet.
  readonly runtime: WorkerRuntime
  // Agent CLI Provider that drives this Worker. Names an entry in PROVIDERS.
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
}

// Resolve a Worker's effective context token budget. The env var
// MARS_CONTEXT_TOKEN_BUDGET globally overrides all per-worker defaults
// (useful to tighten or loosen the budget at runtime without editing code).
// Returns 0 (disabled) when neither the env var nor the override is positive.
/**
 * Fixed context every dispatched agent harness occupies BEFORE the task prompt
 * is even read: the composed system prompt, the built-in tool schemas, any
 * injected MCP server schemas, and the worktree's own instruction files. It is
 * the floor a per-worker `maxContextTokens` has to clear to mean anything — a
 * budget below it kills the run on its first turn while the worker is still
 * booting, rejecting work that has not overflowed anything.
 *
 * 60k is the conservative end of what a headless Claude Code run reports as
 * baseline occupancy with the codegraph + mars-worker MCP servers injected.
 * It is a sanity lower bound for BUDGET VALUES, not a runtime deduction: the
 * pre-flight check below compares the prompt against the raw budget so a
 * generous budget is never silently shrunk.
 */
export const HARNESS_CONTEXT_FLOOR_TOKENS = 60_000

/**
 * Rough token cost of a prompt. Four characters per token is the standard
 * English-text approximation and errs slightly LOW on code-heavy prompts,
 * which is the right direction for a guard that must not reject work it
 * should have run.
 */
export const estimatePromptTokens = (prompt: string): number =>
  Math.ceil(prompt.length / 4)

/**
 * Pre-flight context check. Runs before a Worker dispatches anything, on every
 * provider and both runtimes: if the prompt alone cannot fit the Worker's
 * context budget, the run is hopeless and burning a full agent invocation to
 * discover that mid-way is pure waste.
 *
 * This is the INPUT-side half of budget enforcement and is the only half that
 * exists for a provider which cannot report context occupancy (codex, gemini —
 * see reportsContextOccupancy). Throws with an actionable message; a budget of
 * 0 disables the check along with the rest of the budget machinery.
 */
export const assertPromptFitsContextBudget = (
  config: WorkerConfig,
  prompt: string,
): void => {
  if (config.maxContextTokens <= 0) return
  const estimated = estimatePromptTokens(prompt)
  if (estimated <= config.maxContextTokens) return
  throw new Error(
    `Worker ${config.name}: prompt does not fit the context budget — ` +
      `~${estimated} estimated prompt tokens vs maxContextTokens=${config.maxContextTokens}. ` +
      `Shrink what the caller embeds in the prompt (fewer/shorter artifacts, diffs, or task-graph rows), ` +
      `or raise this Worker's maxContextTokens in WORKER_CONFIGS ` +
      `(MARS_CONTEXT_TOKEN_BUDGET raises it for every Worker at once).`,
  )
}

/**
 * True when a Worker denies the entire built-in tool surface, i.e. it is meant
 * to answer from its prompt alone. Such a Worker must not receive MCP servers
 * either: `--disallowedTools` cannot name `mcp__*` tools, so an injected
 * codegraph / mars-worker server would hand back exactly the repo-browsing
 * surface the deny-list removed.
 */
export const deniesAllToolUse = (config: WorkerConfig): boolean => {
  const denied = new Set(config.disallowedTools)
  return NO_TOOL_USE_DENIED_TOOLS.every((tool) => denied.has(tool))
}

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
  /**
   * Optional callback invoked immediately after the child subprocess is
   * spawned. The dispatch path wires this to
   * `tracker.recordPid(taskId, pid)` so the phantom-task watchdog uses
   * PID liveness instead of the bare wall-clock ceiling on `task.updatedAt`.
   */
  readonly onPid?: (pid: number) => void
  /**
   * The task id this invocation is dispatched for. Forwarded to
   * {@link runClaudeCode} so the worker env is stamped with
   * `MARS_MCP_TASK_ID` and the mars-worker MCP server is injected into the
   * inline `--mcp-config` JSON. Withheld for a Worker that denies the whole
   * tool surface — see {@link deniesAllToolUse}.
   */
  readonly taskId?: string
}

export interface Worker {
  readonly config: WorkerConfig
  readonly runtime: WorkerRuntime
  run(prompt: string, options: RunOptions): Promise<RunClaudeResult>
}

// codegraph nudge appended to the system prompt of the workers that benefit
// most from the pre-indexed code knowledge graph (Planner, Slicer, Coder).
// The codegraph MCP server is registered in the repo-root `.mcp.json`, so the
// `codegraph_*` tools are available to provider runs whose adapter loads
// project MCP config. The nudge steers the
// worker toward the graph before it falls back to broad file-scanning, which
// is what cuts tool calls and context churn.
// Exported so tests can pin the exact blast radius (which Workers carry the
// nudge) and detect unintended additions or removals.
export const CODEGRAPH_NUDGE =
  'A pre-indexed code knowledge graph is available via the `codegraph_*` MCP tools (codegraph_explore, codegraph_search, codegraph_callers, codegraph_callees, codegraph_impact, codegraph_node, codegraph_files, codegraph_status). Before broad file-scanning (rg/fd/Glob across the tree), consult codegraph to locate symbols, trace call graphs, and assess blast radius — it is faster and cheaper than reading files to reconstruct structure. Fall back to direct file reads when the graph lacks the detail you need.'

// One provider owns an entire daemon run. `mars daemon start` resolves the
// persisted `.mars/daemon.json` choice into MARS_WORKER_PROVIDER before any
// workflow imports this registry. An explicit env value remains the one-run
// override. Codex is the hard default for new and unconfigured repositories.
export const WORKER_PROVIDER: ProviderName = resolveProviderName()

export const providerModel = (
  provider: ProviderName,
  tier: ProviderModelTier,
): string => PROVIDER_MODELS[provider][tier]

// The explicit model override remains Coder-only. Every other role selects a
// semantic tier, then the Provider translates that tier to a native model id.
// This prevents switches such as Claude -> Codex from accidentally passing a
// Claude model slug to `codex exec`.
export const CODER_MODEL: string =
  process.env.MARS_WORKER_MODEL ?? providerModel(WORKER_PROVIDER, 'balanced')

// Day-one defaults agreed in the grill for PRD 948691d0. The Coder runs on
// sonnet / high effort / bypassPermissions with the full tool surface (no
// per-Worker disallows beyond the wrapper-layer agent-to-user ban). Fixer
// mirrors Coder's effort, permission posture, and model (Sonnet) — recovery
// briefs are scoped mechanical work (finish-the-job or repair-one-defect) that
// Sonnet handles well; Opus pinning was a cost amplifier under failure storms.
// Fixer also layers backlog-mutation denials so a no-commit Session cannot
// refile its task as a loose end.
// Planner, Slicer, and Triager are read-only synthesis stages: default
// permissions, Edit/Write/NotebookEdit denied. Triager goes further — fast
// tier, low effort, and the whole tool surface denied; see its entry below.
// Per-worker context token budgets. These are intentionally below the model's
// real context window (200k tokens for Claude Sonnet/Opus) to kill a run
// before Claude Code would auto-compact. The 80% warn fires at 144k tokens
// (well inside the window); the kill fires at 180k — leaving 20k of headroom
// before the model's 200k limit so compaction never gets a chance to trigger.
// Triager runs bare because its prompt is self-contained; 80k gives a wide
// safety margin without loading repository instructions into its budget.
// Other focused read-only roles retain 100k to clear the harness floor.
const CODER_CONTEXT_TOKENS = resolveWorkerMaxContextTokens(180_000)
const GENEROUS_CONTEXT_TOKENS = resolveWorkerMaxContextTokens(180_000)
const FOCUSED_CONTEXT_TOKENS = resolveWorkerMaxContextTokens(100_000)
const TRIAGER_CONTEXT_TOKENS = resolveWorkerMaxContextTokens(80_000)

export const WORKER_CONFIGS: Readonly<Record<WorkerName, WorkerConfig>> = {
  Coder: {
    name: 'Coder',
    model: CODER_MODEL,
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    appendSystemPrompt: CODEGRAPH_NUDGE,
    disallowedTools: [],
    outputFormat: 'stream-json',
    maxContextTokens: CODER_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: WORKER_PROVIDER,
    tags: ['coder'],
  },
  Planner: {
    name: 'Planner',
    model: providerModel(WORKER_PROVIDER, 'flagship'),
    effort: 'high',
    permissionMode: 'default',
    bare: false,
    appendSystemPrompt: CODEGRAPH_NUDGE,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: GENEROUS_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: WORKER_PROVIDER,
    tags: ['planner'],
  },
  Slicer: {
    name: 'Slicer',
    model: providerModel(WORKER_PROVIDER, 'flagship'),
    effort: 'high',
    permissionMode: 'default',
    bare: false,
    appendSystemPrompt: CODEGRAPH_NUDGE,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: GENEROUS_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: WORKER_PROVIDER,
    tags: ['slicer'],
  },
  // Triager: a classification call, not a reasoning task. It is handed a task
  // prompt plus a rendered task-graph and must answer with one JSON verdict.
  // Pinned to the FAST tier at low effort — the tier, not a native model id, so
  // whichever provider the daemon runs (Codex by default) resolves its own
  // cheapest model. Denied the ENTIRE tool surface (NO_TOOL_USE_DENIED_TOOLS):
  // it answers from the prompt it is given and must never browse the repo.
  // Running it as a full agentic loop with repo access made it the single
  // largest source of wasted spend (1,303 runs / ~31M tokens in production).
  Triager: {
    name: 'Triager',
    model: providerModel(WORKER_PROVIDER, 'fast'),
    effort: 'low',
    permissionMode: 'default',
    bare: true,
    disallowedTools: NO_TOOL_USE_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: TRIAGER_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: WORKER_PROVIDER,
    tags: ['triager'],
  },
  Fixer: {
    name: 'Fixer',
    model: providerModel(WORKER_PROVIDER, 'balanced'),
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    disallowedTools: FIXER_BACKLOG_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: GENEROUS_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: WORKER_PROVIDER,
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
    model: providerModel(WORKER_PROVIDER, 'balanced'),
    effort: 'medium',
    permissionMode: 'bypassPermissions',
    bare: false,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: FOCUSED_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: WORKER_PROVIDER,
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
    model: providerModel(WORKER_PROVIDER, 'fast'),
    effort: 'medium',
    permissionMode: 'default',
    bare: false,
    disallowedTools: READ_ONLY_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: FOCUSED_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: WORKER_PROVIDER,
    tags: ['scorer'],
  },
  // RescueOperator Worker: court of last resort for a dead-ended Arc.
  // Dispatched when an Arc has no automatic move left (no fix recipe, or
  // recovery Chore itself failed). Carries a pinned system prompt that
  // names exactly three permitted corrective actions (restart, continue,
  // supersede) and forbids all others. Uses bypassPermissions so it can
  // run mars CLI commands headlessly; RESCUE_OPERATOR_DENIED_TOOLS blocks
  // backlog-mutation commands outside the three permitted actions.
  // Sonnet / high effort — targeted recovery work, same posture as Fixer.
  // At most one RescueOperator task fires per Arc (the durable
  // arc_rescue_attempts guard in rescue-operator-spawn.ts). See PRD 94e2a82a.
  RescueOperator: {
    name: 'RescueOperator',
    model: providerModel(WORKER_PROVIDER, 'balanced'),
    effort: 'high',
    permissionMode: 'bypassPermissions',
    bare: false,
    systemPrompt: RESCUE_OPERATOR_SYSTEM_PROMPT,
    disallowedTools: RESCUE_OPERATOR_DENIED_TOOLS,
    outputFormat: 'stream-json',
    maxContextTokens: GENEROUS_CONTEXT_TOKENS,
    runtime: 'headless',
    provider: WORKER_PROVIDER,
    tags: ['rescue-operator'],
  },
} as const

// Construction-time guard. A Worker cannot pin both system-prompt modes;
// silently letting
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
  const provider = PROVIDERS[config.provider]
  // In-run context-overflow handling (warn at 80%, abort at 100%) reads the
  // provider's usage stream as occupancy. Only a per-request provider reports
  // occupancy, so the budget is threaded to the adapter ONLY for those; for a
  // cumulative-usage provider it would compare turn SPEND against a context
  // window and abort runs that are nowhere near the limit. Those providers are
  // covered on the input side by assertPromptFitsContextBudget above.
  const meteredContextBudget = reportsContextOccupancy(provider.headless)
    ? config.maxContextTokens
    : 0
  const guardMode = contextGuardMode(
    provider.headless.capabilities.usageSemantics,
    config.maxContextTokens,
  )
  return {
    config,
    runtime: config.runtime,
    // `async` so a pre-flight rejection surfaces as a rejected promise rather
    // than a synchronous throw — callers hold `run()` to the Promise contract.
    run: async (prompt, options) => {
      assertPromptFitsContextBudget(config, prompt)
      // Say out loud, once per dispatch, that the configured ceiling is NOT
      // armed in-run on this provider. Silently withholding the budget (which
      // is what a cumulative provider requires — its numbers are spend, not
      // occupancy) would leave the operator believing a ceiling is enforced
      // when nothing can abort the run mid-way. The same fact is stamped on
      // every span as `contextGuard` so it is queryable, not just logged.
      if (guardMode === 'in-run-inapplicable') {
        console.warn(
          `[mars] Worker ${config.name} on provider ${config.provider}: in-run context ceiling NOT enforced ` +
            `(maxContextTokens=${config.maxContextTokens}). ${config.provider} reports ` +
            `'${provider.headless.capabilities.usageSemantics}' usage — context occupancy is never observable ` +
            `mid-run, so no turn can be compared against the window. Enforced instead: the pre-flight prompt-fit ` +
            `check (input side) and the window/arc token ceilings ('mars operator'), which bound SPEND after each run.`,
        )
      }
      return config.runtime === 'pty'
        ? runPtySession({
            provider,
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
          })
        : provider.headless.run(prompt, {
            cwd: options.cwd,
            sessionId: options.sessionId,
            onEvent: options.onEvent,
            model: config.model,
            systemPrompt: options.systemPrompt ?? config.systemPrompt ?? config.appendSystemPrompt,
            effort: config.effort,
            permissionMode: config.permissionMode,
            bare: config.bare,
            agent: config.agent,
            disallowedTools: config.disallowedTools,
            maxContextTokens: meteredContextBudget,
            mcpServers: config.mcpConfig,
            externalAbort: options.externalAbort,
            onPid: options.onPid,
            // Passing a taskId is what injects the mars-worker (and, with it,
            // codegraph) MCP servers. A Worker that denies the whole tool
            // surface must not get them back through MCP — see deniesAllToolUse.
            taskId: deniesAllToolUse(config) ? undefined : options.taskId,
          })
    },
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
  RescueOperator: buildWorker(WORKER_CONFIGS.RescueOperator),
} as const

export const getWorker = (name: WorkerName): Worker => Workers[name]

/**
 * Select a Worker for a task based on tag intersection.
 *
 * Iterates through the registered Workers and returns the first one whose
 * `config.tags` set intersects with the task's tag list. When no Worker
 * claims any of the task's tags, the function falls through to the
 * **default headless Worker** — the Coder, running via the selected provider with
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
