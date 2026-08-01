// Shared provider contract — deliberately independent from the provider
// registry and concrete adapters. Keeping these declarations in a leaf module
// lets adapters depend on the contract without depending on their registry.

import type {
  ClaudeEffort,
  ClaudePermissionMode,
  RunClaudeResult,
} from '../lib/git/claude'
import type { ClaudeEvent } from '../lib/claude-stream'
import type { ProviderUsageSemantics } from '../lib/claude-usage'

export type ProviderName = 'claude' | 'gemini' | 'codex'

export type ProviderModelTier = 'flagship' | 'balanced' | 'fast'

export interface ProviderModels {
  readonly flagship: string
  readonly balanced: string
  readonly fast: string
}

/** Provider-native model ids behind MARS's semantic worker tiers. */
export const PROVIDER_MODELS: Readonly<Record<ProviderName, ProviderModels>> = {
  claude: {
    flagship: 'claude-opus-4-7',
    balanced: 'claude-sonnet-4-6',
    fast: 'claude-haiku-4-5-20251001',
  },
  gemini: {
    flagship: 'gemini-2.5-pro',
    balanced: 'gemini-2.5-pro',
    fast: 'gemini-2.5-flash',
  },
  codex: {
    flagship: 'gpt-5.6-sol',
    balanced: 'gpt-5.6-terra',
    fast: 'gpt-5.6-luna',
  },
} as const

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
export type HeadlessRunOpts = Readonly<{
  cwd: string
  sessionId?: string
  onEvent?: (event: ClaudeEvent) => void | Promise<void>
  model?: string
  systemPrompt?: string
  effort?: ClaudeEffort
  permissionMode?: ClaudePermissionMode
  bare?: boolean
  agent?: string
  disallowedTools?: ReadonlyArray<string>
  maxContextTokens?: number
  mcpServers?: Readonly<Record<string, unknown>>
  externalAbort?: AbortSignal
  /**
   * Optional callback invoked immediately after the child subprocess is
   * spawned. Forwarded verbatim to {@link runClaudeCode} so the dispatch
   * path can record the PID on the in-flight tracker entry.
   */
  onPid?: (pid: number) => void
  /**
   * Task id for this dispatch. Forwarded to {@link runClaudeCode} so
   * `MARS_MCP_TASK_ID` is stamped in the worker env and the mars-worker
   * MCP server is injected into the inline `--mcp-config` JSON.
   */
  taskId?: string
}>

// Adapter for headless (non-interactive subprocess) dispatch of a Provider's
// agent CLI. A Provider that supports headless dispatch implements this
// interface; one that does not provides a stub that throws so callers fail
// fast at runtime rather than silently falling back to an unintended path.
//
// The `capabilities` descriptor advertises which result fields the adapter
// populates, and HOW its usage numbers must be read, so dispatch and telemetry
// logic can branch without inspecting the return value at runtime.
//
// `usageSemantics` is the load-bearing one: a provider that reports cumulative
// turn spend (codex) must never have that number read as context occupancy —
// see ProviderUsageSemantics in ../lib/claude-usage.
export interface HeadlessAdapter {
  run(prompt: string, opts: HeadlessRunOpts): Promise<RunClaudeResult>
  /** Decode this provider's complete stdout into normalized stream events. */
  readOutput(stdout: string): ClaudeEvent[]
  readonly capabilities: {
    readonly usageSemantics: ProviderUsageSemantics
    readonly quotaRejected: boolean
    readonly sessionId: boolean
  }
}

export type RunHeadlessProviderOpts = Omit<HeadlessRunOpts, 'model'> & {
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
  permissionMode?: ClaudePermissionMode
  effort?: ClaudeEffort
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

// Descriptor for a single agent CLI. Bundles:
//   - spawnArgv  : build the argv array used to launch the process;
//   - feedPrompt : write the task prompt into a running process handle;
//   - doneSignal : optional descriptor that tells the orchestrator how to
//                  detect session completion beyond a normal process exit;
//   - prepare    : optional pre-spawn setup — called with (cwd, sessionId)
//                  before the process is launched. Providers that require
//                  side-effects before the process starts (e.g. writing a
//                  Stop hook for the claude status-file done-signal) implement
//                  this; providers that need no setup omit it.
//   - isReady    : optional readiness predicate. When present, runPtySession
//                  polls the ANSI-stripped pty buffer on a ~250 ms interval
//                  before calling feedPrompt, proceeding only once this returns
//                  true or a 30 s timeout elapses (with a logged warning). This
//                  prevents keystrokes from landing before the TUI input box has
//                  rendered.
export interface Provider {
  readonly name: ProviderName
  conversationMemory(model: string): ConversationMemoryFacts
  spawnArgv(opts: SpawnOpts): readonly string[]
  feedPrompt(handle: ProcessHandle, prompt: string): Promise<void>
  readonly doneSignal?: ProviderDoneSignal
  prepare?(cwd: string, sessionId: string): void
  readonly isReady?: (strippedBuffer: string) => boolean
  // Headless dispatch adapter. Required on every Provider so buildWorker's
  // headless branch can call it uniformly. Providers that do not yet have a
  // real headless implementation must fail explicitly rather than silently
  // falling back to a different provider.
  readonly headless: HeadlessAdapter
}
