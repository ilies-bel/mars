// Provider registry — one auditable location for how a Worker spawns and
// feeds prompts to an agent CLI. Each Provider bundles the spawn argv
// builder, the prompt-feed method, and an optional done-signal hook.

import { installClaudeStopHook, waitForClaudeDone } from './claude-done-signal'
import {
  runClaudeCode,
  AGENT_TO_USER_DENIED_TOOLS,
  toClaudeSessionId,
  type RunClaudeResult,
  type ClaudeEffort,
  type ClaudePermissionMode,
} from '../lib/git/claude'
import { readClaudeOutput, type ClaudeEvent } from '../lib/claude-stream'
import type { ProviderUsageSemantics } from '../lib/claude-usage'
import { codexHeadless } from './providers/codex-headless'
import { geminiHeadless } from './providers/gemini-headless'

export type ProviderName = 'claude' | 'gemini' | 'codex'

export type ProviderModelTier = 'flagship' | 'balanced' | 'fast'

export interface ProviderModels {
  readonly flagship: string
  readonly balanced: string
  readonly fast: string
}

/**
 * Provider-declared limits that govern whether consecutive conversation
 * requests can reuse a prefix and how much transcript can fit in one turn.
 */
export interface ConversationMemoryFacts {
  readonly retentionMs: number
  readonly minimumReusablePrefixTokens: number
  readonly contextWindowTokens: number
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

const conversationMemoryFor = (
  provider: ProviderName,
  models: Readonly<Record<string, ConversationMemoryFacts>>,
): ((model: string) => ConversationMemoryFacts) => (model: string): ConversationMemoryFacts => {
  const facts = models[model]
  if (!facts) {
    throw new Error(`Provider '${provider}' has no conversation-memory facts for model '${model}'`)
  }
  return facts
}

const CLAUDE_CONVERSATION_MEMORY: Readonly<Record<string, ConversationMemoryFacts>> = {
  'claude-opus-4-7': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 1024, contextWindowTokens: 200_000 },
  'claude-sonnet-4-6': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 1024, contextWindowTokens: 200_000 },
  'claude-haiku-4-5-20251001': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 1024, contextWindowTokens: 200_000 },
}

const GEMINI_CONVERSATION_MEMORY: Readonly<Record<string, ConversationMemoryFacts>> = {
  'gemini-2.5-pro': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 4096, contextWindowTokens: 1_048_576 },
  'gemini-2.5-flash': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 1024, contextWindowTokens: 1_048_576 },
}

const CODEX_CONVERSATION_MEMORY: Readonly<Record<string, ConversationMemoryFacts>> = {
  'gpt-5.5': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 1024, contextWindowTokens: 200_000 },
  'gpt-5.6-sol': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 1024, contextWindowTokens: 200_000 },
  'gpt-5.6-terra': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 1024, contextWindowTokens: 200_000 },
  'gpt-5.6-luna': { retentionMs: 5 * 60 * 1000, minimumReusablePrefixTokens: 1024, contextWindowTokens: 200_000 },
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

/**
 * True when this provider can report current context occupancy, and therefore
 * when in-run context-overflow handling (warn at 80%, abort at 100% of a
 * worker's maxContextTokens) is meaningful. A provider that reports only
 * cumulative spend — or nothing at all — must be skipped by that logic; its
 * budget is enforced on the INPUT side by the pre-flight prompt check in
 * ../workers (see estimatePromptTokens).
 */
export const reportsContextOccupancy = (adapter: HeadlessAdapter): boolean =>
  adapter.capabilities.usageSemantics === 'per-request'

/**
 * The usage semantics of a Provider by name. The single lookup every telemetry
 * call site uses to decide HOW to read a run's token numbers — reading the
 * per-request (assistant-event) shape unconditionally is what made every Codex
 * run report zero tokens everywhere.
 */
export const usageSemanticsOf = (provider: ProviderName): ProviderUsageSemantics =>
  PROVIDERS[provider].headless.capabilities.usageSemantics

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

// Registry of every known Provider keyed by ProviderName.
export const PROVIDERS: Readonly<Record<ProviderName, Provider>> = {
  claude: {
    name: 'claude',
    conversationMemory: conversationMemoryFor('claude', CLAUDE_CONVERSATION_MEMORY),
    // Argv for interactive (non-headless) claude invocations under the native
    // TTY harness. No `-p` flag — the agent runs in interactive mode and
    // receives the task prompt via feedPrompt below.
    //
    // `--session-id <uuid>` starts a brand-new named session rather than
    // reopening an existing one. The previous `--resume <id>` flag opened the
    // interactive resume picker when the id was unknown to claude, causing the
    // done-signal to never fire and the run to be killed at timeout (exit 137).
    //
    // claude requires `--session-id` to be a valid RFC 4122 UUID. Orchestrator
    // task ids (e.g. "mars-586e6998") are not UUIDs, so we derive a
    // deterministic UUID v5 (SHA-1 over the DNS namespace + task-id bytes)
    // rather than storing a separate mapping. A task id that already looks like
    // a UUID is passed through unchanged.
    spawnArgv: ({
      sessionId,
      model,
      permissionMode,
      effort,
      disallowedTools,
      agent,
      appendSystemPrompt,
    }: SpawnOpts): readonly string[] => {
      // claude requires --session-id to be a valid RFC 4122 UUID; task ids are
      // not, so normalize via the shared helper (deterministic UUID v5). This
      // is the SAME helper the headless/stream path uses, so a given task id
      // maps to the same session UUID on either path.
      const sessionUUID = sessionId ? toClaudeSessionId(sessionId) : undefined

      // Union caller-supplied disallowedTools with the agent-to-user denial.
      // Mirrors mergeDisallowedTools in claude.ts — the agent-to-user ban
      // (AskUserQuestion, SendUserMessage) cannot be removed by a caller.
      const mergedDisallowed = new Set<string>(AGENT_TO_USER_DENIED_TOOLS)
      for (const tool of disallowedTools ?? []) {
        const trimmed = tool.trim()
        if (trimmed.length > 0) mergedDisallowed.add(trimmed)
      }

      return [
        'claude',
        ...(model ? ['--model', model] : []),
        ...(sessionUUID ? ['--session-id', sessionUUID] : []),
        // Permission posture: bypassPermissions → --dangerously-skip-permissions;
        // any other explicit mode → --permission-mode <mode>; absent → no flag.
        ...(permissionMode === 'bypassPermissions'
          ? ['--dangerously-skip-permissions']
          : permissionMode !== undefined
            ? ['--permission-mode', permissionMode]
            : []),
        ...(effort ? ['--effort', effort] : []),
        '--disallowedTools',
        [...mergedDisallowed].join(','),
        ...(agent ? ['--agent', agent] : []),
        ...(appendSystemPrompt ? ['--append-system-prompt', appendSystemPrompt] : []),
      ]
    },
    // Write the prompt into the running pty followed by the submit key
    // sequence (CR) so the interactive harness starts execution.
    // The delay between writing the prompt text and the Enter keypress is
    // required: the claude TUI must finish ingesting the pasted text before
    // the CR arrives or the Enter keypress is silently dropped and the prompt
    // sits un-submitted in the input box (observed with claude CLI 2.1.159).
    // See: github.com/Dicklesworthstone/ntm internal/tmux/session.go SendKeysWithDelay
    feedPrompt: async (handle: ProcessHandle, prompt: string): Promise<void> => {
      handle.write(prompt)
      await new Promise<void>((r) => setTimeout(r, 150))
      handle.write('\r')
    },
    // Status-file done-signal: the Stop hook installed by installClaudeStopHook
    // writes a sentinel file; waitForClaudeDone watches for it.
    doneSignal: {
      kind: 'status-file' as const,
      wait: (sessionId: string, cwd: string, signal: AbortSignal): Promise<void> =>
        waitForClaudeDone(cwd, sessionId, signal),
    },
    // Pre-spawn setup: install the Stop hook so the done-signal sentinel file
    // is written when Claude's turn ends. Must run before the process starts.
    prepare: installClaudeStopHook,
    // Readiness gate for the claude TUI: the input chevron (❯) appears in the
    // buffer once the input box has rendered, and the persistent status footer
    // always contains the model name or a keyboard-shortcut hint. Waiting for
    // both prevents typed keystrokes from landing before the TUI is ready.
    isReady: (buf: string): boolean =>
      buf.includes('❯') &&
      /bypass permissions|shift\+tab to cycle|Haiku|Sonnet|Opus/i.test(buf),
    // Headless adapter: delegates directly to runClaudeCode so the headless
    // dispatch path is bit-identical to the pre-seam behaviour. runClaudeCode
    // extracts the session_id and detects quota-rejection, and Claude Code
    // stamps per-request usage on every assistant event — so the latest one is
    // genuine context occupancy ('per-request').
    headless: {
      capabilities: {
        usageSemantics: 'per-request',
        quotaRejected: true,
        sessionId: true,
      },
      run: (prompt: string, opts: HeadlessRunOpts): Promise<RunClaudeResult> =>
        runClaudeCode({ prompt, ...opts }),
      readOutput: readClaudeOutput,
    },
  },
  gemini: {
    name: 'gemini',
    conversationMemory: conversationMemoryFor('gemini', GEMINI_CONVERSATION_MEMORY),
    // Argv for interactive gemini invocations under the native TTY harness.
    // No headless/pipe flag — the agent runs interactively and receives the
    // task prompt via feedPrompt below.
    spawnArgv: (_opts: SpawnOpts): readonly string[] => ['gemini'],
    // Write the prompt into the running pty followed by the submit key
    // sequence (CR) so the interactive harness starts execution.
    feedPrompt: async (handle: ProcessHandle, prompt: string): Promise<void> => {
      handle.write(prompt)
      handle.write('\r')
    },
    // Prompt-scan done-signal: the orchestrator watches the pty output buffer
    // for the gemini shell prompt returning after the spinner clears.
    doneSignal: {
      kind: 'prompt-scan' as const,
      // Gemini CLI returns to this prefix once it is ready for the next input.
      promptPrefix: '> ',
      // Braille spinner characters emitted by gemini while processing a task,
      // followed by optional whitespace / ANSI clear sequences.
      spinnerOverride: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    },
    // Headless adapter: spawns `gemini -p`, normalises its line-buffered stdout
    // to ClaudeEvent shape, and returns a RunClaudeResult with null sessionId
    // and quotaRejected (signals gemini does not expose).
    headless: geminiHeadless,
  },
  codex: {
    name: 'codex',
    conversationMemory: conversationMemoryFor('codex', CODEX_CONVERSATION_MEMORY),
    // Argv for interactive codex invocations under the native TTY harness.
    // No headless/pipe flag — the agent runs interactively and receives the
    // task prompt via feedPrompt below.
    spawnArgv: ({ model }: SpawnOpts): readonly string[] => [
      'codex',
      ...(model ? ['--model', model] : []),
    ],
    // Write the prompt into the running pty followed by the submit key
    // sequence (CR) so the interactive harness starts execution.
    feedPrompt: async (handle: ProcessHandle, prompt: string): Promise<void> => {
      handle.write(prompt)
      handle.write('\r')
    },
    // Prompt-scan done-signal: the orchestrator watches the pty output buffer
    // for the codex shell prompt returning after the spinner clears.
    doneSignal: {
      kind: 'prompt-scan' as const,
      // codex CLI returns to this prefix once it is ready for the next input.
      promptPrefix: 'codex>',
      // Braille spinner characters emitted by codex while processing a task,
      // followed by a space and the rest of the spinner text up to end-of-line.
      spinnerOverride: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .*$/,
    },
    // Headless adapter: spawns `codex exec --json`, normalises its JSONL
    // stream to ClaudeEvent shape, and returns a RunClaudeResult with null
    // sessionId and quotaRejected (signals codex does not expose).
    headless: codexHeadless,
  },
} as const

const KNOWN_PROVIDER_NAMES: readonly ProviderName[] = ['claude', 'codex', 'gemini']

export const resolveProviderName = (
  raw: string | undefined = process.env.MARS_WORKER_PROVIDER,
): ProviderName => {
  if (raw === undefined || raw.trim() === '') return 'codex'
  if (!(KNOWN_PROVIDER_NAMES as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown MARS_WORKER_PROVIDER '${raw}' — known: ${KNOWN_PROVIDER_NAMES.join(', ')}`,
    )
  }
  return raw as ProviderName
}

/**
 * Provider-neutral entry point for one-off headless model calls outside a
 * named Worker. It applies the global provider, translates semantic model
 * tiers, and owns wall-clock cancellation so callers never shell out to a
 * provider CLI directly.
 */
export const runHeadlessProvider = async (
  prompt: string,
  opts: RunHeadlessProviderOpts,
): Promise<RunClaudeResult> => {
  const providerName = opts.provider ?? resolveProviderName()
  const provider = PROVIDERS[providerName]
  const abort = new AbortController()
  const onExternalAbort = (): void => abort.abort()
  if (opts.externalAbort?.aborted) abort.abort()
  else opts.externalAbort?.addEventListener('abort', onExternalAbort, { once: true })

  const timeout =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0
      ? setTimeout(() => abort.abort(), opts.timeoutMs)
      : undefined

  try {
    const { provider: _provider, modelTier = 'balanced', timeoutMs: _timeoutMs, ...runOpts } = opts
    return await provider.headless.run(prompt, {
      ...runOpts,
      model: opts.model ?? PROVIDER_MODELS[providerName][modelTier],
      externalAbort: abort.signal,
    })
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    opts.externalAbort?.removeEventListener('abort', onExternalAbort)
  }
}
