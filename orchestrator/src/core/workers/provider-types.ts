// Shared provider contract — deliberately independent from the provider
// registry and concrete adapters. Keeping these declarations in a leaf module
// lets adapters depend on the contract without depending on their registry.
//
// ADR-0097 reshape: the seam is split into two layers.
//
//   ProviderCore           — transport-neutral. Any backend (CLI subprocess,
//                            key-backed HTTP, future transports) implements this.
//                            No subprocess-specific members.
//
//   CliSubprocessProvider  — CLI-subprocess extension of ProviderCore. Only
//                            providers that drive a local binary (claude, gemini,
//                            codex) implement this. spawnArgv, feedPrompt,
//                            isReady, doneSignal, prepare all live here.
//
//   HeadlessAdapter        — transport-neutral headless-run contract (run +
//                            capabilities). No stdout decoding.
//
//   CliHeadlessAdapter     — CLI extension: adds readOutput(stdout) for
//                            normalising a subprocess's captured stdout.
//
// Provider = ProviderCore is kept as a backward-compatible alias so existing
// imports that only need the core members continue to compile without edits.

import type {
  AgentEffort,
  AgentPermissionMode,
  RunAgentResult,
} from '../ports/executor/types'
import type { AgentEvent } from '../lib/claude-stream'
import type { ProviderUsageSemantics } from '../lib/claude-usage'

/**
 * Provider identifier. Was a closed union (`'claude' | 'gemini' | 'codex'`);
 * opened to `string` so a provider can be registered at runtime without a
 * type-level edit here (see `provider-registry.ts`). The three built-ins are
 * still `'claude'`, `'gemini'`, and `'codex'` — this alias exists purely so
 * every existing `ProviderName`-typed call site keeps compiling unchanged.
 */
export type ProviderName = string

export type ProviderModelTier = 'flagship' | 'balanced' | 'fast'

export interface ProviderModels {
  readonly flagship: string
  readonly balanced: string
  readonly fast: string
}

/**
 * `PROVIDER_MODELS` and `tierForModel` are now registry-backed (see
 * `provider-registry.ts`) — re-exported here so the many existing
 * `from './provider-types'` / `from '../workers/provider-types'` imports
 * keep resolving without a per-file edit. New code should prefer importing
 * them (or `getProvider`/`requireProvider`/`listProviders`) directly from
 * `./provider-registry`.
 */
export { PROVIDER_MODELS, tierForModel } from './provider-registry'

/**
 * Provider-declared limits that govern whether consecutive conversation
 * requests can reuse a prefix and how much transcript can fit in one turn.
 */
export interface ConversationMemoryFacts {
  readonly retentionMs: number
  readonly minimumReusablePrefixTokens: number
  readonly contextWindowTokens: number
}

// Runtime options forwarded to HeadlessAdapter.run when the orchestrator
// dispatches a headless (non-interactive subprocess) invocation. Mirrors
// the fields currently threaded into runClaudeCode from buildWorker so
// the Claude adapter is a thin pass-through with no argument mapping.
// The `systemPrompt` field carries the fully-resolved prompt string —
// callers collapse `options.systemPrompt ?? config.systemPrompt ??
// config.appendSystemPrompt` before calling run().
//
// Deliberately Port-legal: every field here is plain data (strings,
// numbers, booleans, readonly arrays/records) with no function values and
// no `AbortSignal`. That is what lets this shape cross a serialization
// boundary (a remote Executor port, a persisted dispatch record) intact.
// The three fields that are NOT serializable — the event callback, the
// abort signal, and the PID callback — live on {@link HeadlessRunContext}
// instead, passed as a separate in-process-only argument. See ADR-0097
// ("every seam is a cordis service Port with serializable contracts") and
// the `ExecutorPortRequest`/`RunAgentArgs` split in `../lib/git/claude.ts`.
export type HeadlessRunOpts = Readonly<{
  cwd: string
  sessionId?: string
  model?: string
  systemPrompt?: string
  effort?: AgentEffort
  permissionMode?: AgentPermissionMode
  bare?: boolean
  agent?: string
  disallowedTools?: ReadonlyArray<string>
  /**
   * Explicit sandbox-mode override, independent of `disallowedTools`.
   *
   * Providers WITHOUT a discrete per-tool deny mechanism (codex) derive
   * their OS-level sandbox mode from `disallowedTools` by default (see
   * `isReadOnlyRun` in `providers/codex-headless.ts`): denying both `Edit`
   * and `Write` normally forces `--sandbox read-only`. That coupling is
   * wrong for a Worker that must deny file-editing tools yet still needs
   * OS-level write access to run ordinary subprocesses — e.g. the
   * rescue-operator, whose permitted actions are `mars restart` / `mars
   * continue` / `mars task add --supersede`. Empirically, codex's
   * `read-only` sandbox denies ALL filesystem writes, including under
   * `/tmp`/`$TMPDIR`; the dev-mode `mars` CLI (a tsx wrapper) needs to
   * create a local IPC pipe there at startup, so under `read-only` even
   * `mars --version` fails with `EPERM` on `Server.listen` before argument
   * parsing — the rescue-operator would be a silent total no-op.
   *
   * Set this field to bypass the `disallowedTools`-derived default for
   * this run. Leave unset for every other Worker so their existing
   * behaviour (including the five read-only Workers that share the
   * `Edit`+`Write` deny shape) is unaffected.
   */
  forceSandbox?: 'workspace-write' | 'read-only'
  maxContextTokens?: number
  mcpServers?: Readonly<Record<string, unknown>>
  /**
   * Task id for this dispatch. Forwarded to {@link runClaudeCode} so
   * `MARS_MCP_TASK_ID` is stamped in the worker env and the mars-worker
   * MCP server is injected into the inline `--mcp-config` JSON.
   */
  taskId?: string
}>

// Out-of-band extras for a headless run that are meaningful only to an
// in-process adapter invocation and cannot cross a serialization boundary:
// a live event callback, an abort signal, and a PID callback. Split out of
// {@link HeadlessRunOpts} so that type stays Port-legal (see its doc
// comment). Passed as HeadlessAdapter.run's optional third argument.
export interface HeadlessRunContext {
  onEvent?: (event: AgentEvent) => void | Promise<void>
  externalAbort?: AbortSignal
  /**
   * Optional callback invoked immediately after the child subprocess is
   * spawned. Forwarded verbatim to {@link runClaudeCode} so the dispatch
   * path can record the PID on the in-flight tracker entry.
   */
  onPid?: (pid: number) => void
}

// Adapter for headless (non-interactive) dispatch of a Provider's agent.
// Transport-neutral: any backend (CLI subprocess, key-backed HTTP) implements
// this interface.
//
// The `capabilities` descriptor advertises which result fields the adapter
// populates, and HOW its usage numbers must be read, so dispatch and telemetry
// logic can branch without inspecting the return value at runtime.
//
// `usageSemantics` is the load-bearing one: a provider that reports cumulative
// turn spend (codex) must never have that number read as context occupancy —
// see ProviderUsageSemantics in ../lib/claude-usage.
export interface HeadlessAdapter {
  run(prompt: string, opts: HeadlessRunOpts, ctx?: HeadlessRunContext): Promise<RunAgentResult>
  readonly capabilities: {
    readonly usageSemantics: ProviderUsageSemantics
    readonly quotaRejected: boolean
    readonly sessionId: boolean
  }
}

// CLI-subprocess extension of HeadlessAdapter. Adds stdout decoding, which is
// meaningful only when the provider drives a subprocess with capturable stdout.
// A key-backed HTTP adapter normalises the vendor's response body directly
// inside its `run()` implementation and has no stdout to decode here.
export interface CliHeadlessAdapter extends HeadlessAdapter {
  /** Decode this provider's complete stdout into normalized stream events. */
  readOutput(stdout: string): AgentEvent[]
}

export type RunHeadlessProviderOpts = Omit<HeadlessRunOpts, 'model'> &
  HeadlessRunContext & {
    readonly provider?: ProviderName
    readonly model?: string
    readonly modelTier?: ProviderModelTier
    readonly timeoutMs?: number
  }

// Runtime options forwarded to spawnArgv when the orchestrator launches
// a Provider process. Named fields instead of a plain record so callers
// get type-checked values and providers can safely destructure by name.
// All fields are optional — providers that don't need a field ignore it.
export type SpawnOpts = Readonly<{
  model?: string
  sessionId?: string
  permissionMode?: AgentPermissionMode
  effort?: AgentEffort
  disallowedTools?: readonly string[]
  agent?: string
  appendSystemPrompt?: string
}>

// Minimal handle to a running provider process exposed to feedPrompt and
// doneSignal. Matches the write-side of PtyHandle so the interactive harness
// can supply the concrete pty handle directly without adaptation.
export interface ProcessHandle {
  write(data: string): void
}

// Discriminated union describing how the orchestrator should detect that a
// Provider's agent has finished a task cycle.
//
//   status-file  — the agent writes a sentinel file; the orchestrator watches
//                  that path. Implemented in claude-done-signal.ts.
//   prompt-scan  — the pty buffer is scanned for a spinnerOverride sequence
//                  followed by the shell promptPrefix returning.
export interface StatusFileDoneSignal {
  readonly kind: 'status-file'
  /**
   * Watches <cwd>/.mars/pty-status/<sessionId>.json and resolves when the
   * file appears (written by the Stop hook). Rejects with an AbortError
   * when the signal fires.
   */
  wait(sessionId: string, cwd: string, signal: AbortSignal): Promise<void>
}

export interface PromptScanDoneSignal {
  readonly kind: 'prompt-scan'
  /** Fixed string the agent shell prints when it returns to the prompt. */
  readonly promptPrefix: string
  /** Regex matching the spinner-override/clear sequence the agent emits on
   *  task completion, before the prompt reappears. */
  readonly spinnerOverride: RegExp
}

export type ProviderDoneSignal = StatusFileDoneSignal | PromptScanDoneSignal

// ProviderCore — transport-neutral provider contract. Any backend implements
// this: a CLI subprocess, a key-backed HTTP adapter, or a future transport.
// No subprocess-specific members live here.
export interface ProviderCore {
  readonly name: ProviderName
  conversationMemory(model: string): ConversationMemoryFacts
  // Headless dispatch adapter. Required on every Provider so buildWorker's
  // headless branch can call it uniformly.
  readonly headless: HeadlessAdapter
}

// CliSubprocessProvider — CLI-subprocess extension of ProviderCore. Only
// providers that drive a local binary (claude, gemini, codex) implement this.
//
//   - spawnArgv  : build the argv array used to launch the process;
//   - feedPrompt : write the task prompt into a running process handle;
//   - doneSignal : optional descriptor that tells the orchestrator how to
//                  detect session completion beyond a normal process exit;
//   - prepare    : optional pre-spawn setup — called with (cwd, sessionId)
//                  before the process is launched;
//   - isReady    : optional readiness predicate. When present, runPtySession
//                  polls the ANSI-stripped pty buffer on a ~250 ms interval
//                  before calling feedPrompt, proceeding only once this returns
//                  true or a 30 s timeout elapses.
export interface CliSubprocessProvider extends ProviderCore {
  // Narrows the base HeadlessAdapter to the CLI-specific variant that can
  // decode stdout. CLI providers always carry readOutput.
  readonly headless: CliHeadlessAdapter
  spawnArgv(opts: SpawnOpts): readonly string[]
  feedPrompt(handle: ProcessHandle, prompt: string): Promise<void>
  readonly doneSignal?: ProviderDoneSignal
  prepare?(cwd: string, sessionId: string): void
  readonly isReady?: (strippedBuffer: string) => boolean
}

// Provider — backward-compatible alias for ProviderCore. Existing imports that
// only consume the transport-neutral members continue to compile unchanged.
// Code that needs CLI-subprocess members should use CliSubprocessProvider.
export type Provider = ProviderCore
