/**
 * Chat runner — drives a chat turn against the Codex Responses API directly
 * (see codex-api.ts), streams typed segments over the `chat` SSE channel, and
 * persists the assistant reply to `chat_messages` when the run finishes.
 *
 * The daemon owns the whole agent loop: it replays the thread transcript as
 * Responses input items on every turn (`store: false` — no server-side session,
 * nothing in the context window the daemon didn't put there), exposes one
 * `shell` function tool, executes tool calls itself, and feeds the outputs
 * back until the model produces a final message.
 *
 * One run per thread at a time (in-memory guard); concurrent POST requests
 * get a 409 response from the HTTP route. A 10-minute wall-clock timeout
 * finalises the run with an `error` segment. `killAll()` is called by the
 * daemon shutdown path to abort all live runs.
 *
 * Error-kind handling (inlined in _run to avoid single-caller helpers):
 *   auth       → one silent token refresh, then global flag + throttle with
 *                backoff; clears on re-auth
 *   rate-limit → throttle with backoff; auto-retries up to 3 times
 *   http/network → terminal error (user-safe message, no provider details)
 */

import { buildWorkerEnv, runSubprocessStreaming } from '../lib/git/claude'
import {
  appendMessage,
  getThread,
  setThreadStatus,
  updateThreadTitle,
  type AlertSegment,
  type ChatMessage,
} from '../lib/chat-store'
import type { ViewStreamHub } from './view/stream-hub'
import type { ChatStreamHub } from './chat-stream-hub'
import { resolveChatSystemPrompt } from './chat-system-prompt'
import {
  CodexApiError,
  loadCodexAuth,
  refreshCodexAuth,
  streamCodexResponse,
  type CodexAuth,
  type FunctionToolDef,
  type ResponseInputItem,
} from './codex-api'

// ── Attachment info ───────────────────────────────────────────────────────────

/**
 * Metadata for a file uploaded via `POST /chat/threads/:id/attachments`.
 * Passed to `sendMessage` so the runner can embed attachment instructions
 * in the prompt and persist attachment segments on the user message.
 */
export interface AttachmentInfo {
  id: string
  path: string
  mimeType: string
  name: string
  size: number
}

// ── Segment types ─────────────────────────────────────────────────────────────

/**
 * A single typed segment produced from the Codex Responses SSE stream. Each
 * segment maps to one recognisable unit of the run: a text block, a reasoning
 * summary, a tool call, its result, the final usage summary, or an error.
 *
 * The `attachment` variant is produced by the HTTP route when the user
 * message carries file attachments. It is persisted on the user message and
 * rendered by the UI; it is NOT emitted by the stream parser.
 */
export type ChatSegment =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; isError: boolean }
  | { type: 'result'; durationMs: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cost: number | null }
  | { type: 'error'; message: string }
  | { type: 'attachment'; path: string; mimeType: string; name: string; size: number; kindHint: 'image' | 'audio' | 'video' }

// MIME type classification used when building attachment segments and prompt text.
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const AUDIO_MIMES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm'])

// ── Parser ────────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Derive a short display name for a shell command.
 * - `mars <verb> ...` → `mars <verb>` (e.g. `mars task add "..."` → `mars task`)
 * - anything else     → first token   (e.g. `ls -la` → `ls`)
 */
const deriveCommandName = (command: string): string => {
  const tokens = command.trim().split(/\s+/)
  if (tokens[0] === 'mars' && tokens[1]) return `mars ${tokens[1]}`
  return tokens[0] ?? 'shell'
}

/**
 * Convert a single Codex Responses SSE event into zero or more `ChatSegment`
 * values. The function is pure (no I/O) and exported for unit testing.
 *
 * Recognised event → segment mappings:
 * - `response.output_item.done(message)`       → `text`
 * - `response.output_item.done(function_call)` → `tool_use`
 * - `response.output_item.done(reasoning)`     → `thinking` (summary text)
 * - `response.completed`                       → `result` (usage)
 * All other event types produce no segments.
 */
export const parseEventToSegments = (event: unknown): ChatSegment[] => {
  const segs: ChatSegment[] = []
  if (!isObject(event)) return segs

  if (event.type === 'response.output_item.done' && isObject(event.item)) {
    const item = event.item
    if (item.type === 'message' && Array.isArray(item.content)) {
      const text = item.content
        .filter((p): p is { type: string; text: string } =>
          isObject(p) && p.type === 'output_text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
      if (text.length > 0) segs.push({ type: 'text', text })
    } else if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.arguments === 'string') {
      let args: unknown
      try { args = JSON.parse(item.arguments) } catch { args = { raw: item.arguments } }
      const command = isObject(args) && typeof args.command === 'string' ? args.command : null
      segs.push({
        type: 'tool_use',
        id: item.call_id,
        name: command !== null
          ? deriveCommandName(command)
          : typeof item.name === 'string' ? item.name : 'tool',
        input: args,
      })
    } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      const thinking = item.summary
        .filter((p): p is { type: string; text: string } =>
          isObject(p) && p.type === 'summary_text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n\n')
      if (thinking.length > 0) segs.push({ type: 'thinking', thinking })
    }
  } else if (event.type === 'response.completed') {
    const usage = isObject(event.response) ? event.response.usage : undefined
    const details = isObject(usage) ? usage.input_tokens_details : undefined
    segs.push({
      type: 'result',
      durationMs: null,
      inputTokens: isObject(usage) && typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
      outputTokens: isObject(usage) && typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
      cacheReadTokens: isObject(details) && typeof details.cached_tokens === 'number' ? details.cached_tokens : null,
      cost: null,
    })
  }

  return segs
}

// ── Transcript → Responses input ──────────────────────────────────────────────

/** The single function tool the chat agent gets. */
const SHELL_TOOL: FunctionToolDef = {
  type: 'function',
  name: 'shell',
  description:
    'Run a shell command from the repository root and return its stdout, stderr, and exit code. ' +
    'Use it for mars CLI commands, git, file inspection, and daemon HTTP queries.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run (passed to bash -lc).' },
    },
    required: ['command'],
    additionalProperties: false,
  },
}

const CHAT_MODEL = 'gpt-5.5'
/** Upper bound on model↔tool round-trips within one chat turn. */
const MAX_TOOL_TURNS = 40
/** Per-call cap on stdout/stderr fed back to the model and persisted. */
const TOOL_OUTPUT_CHAR_CAP = 10_000
/** Rough cap on the serialized replayed transcript; oldest messages drop first. */
const MAX_TRANSCRIPT_CHARS = 120_000

const truncate = (s: string, cap: number): string =>
  s.length > cap ? `${s.slice(0, cap)}…[truncated]` : s

const renderAlertText = (seg: AlertSegment): string => {
  const lines = [`[Alert: ${seg.kind}] ${seg.title}`, `Why now: ${seg.whyNow}`]
  const actionLabels = seg.actions.map((a) => a.label).join(', ')
  if (actionLabels) lines.push(`Available actions: ${actionLabels}`)
  return lines.join('\n')
}

/** Convert one persisted chat message into its Responses input items. */
const messageToItems = (msg: ChatMessage): ResponseInputItem[] => {
  const role: 'user' | 'assistant' = msg.role
  const segs = Array.isArray(msg.segments) ? (msg.segments as unknown[]) : []
  if (segs.length === 0) {
    if (msg.content.trim().length === 0) return []
    return [{ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: msg.content }] }]
  }

  // Pair each tool_use with its tool_result so the API never sees a
  // function_call without a matching function_call_output.
  const resultsById = new Map<string, { content: unknown }>()
  for (const seg of segs) {
    if (isObject(seg) && seg.type === 'tool_result' && typeof seg.tool_use_id === 'string') {
      resultsById.set(seg.tool_use_id, { content: seg.content })
    }
  }

  const items: ResponseInputItem[] = []
  const textParts: string[] = []
  for (const seg of segs) {
    if (!isObject(seg)) continue
    if (seg.type === 'text' && typeof seg.text === 'string') {
      textParts.push(seg.text)
    } else if (seg.type === 'alert') {
      textParts.push(renderAlertText(seg as unknown as AlertSegment))
    } else if (seg.type === 'attachment' && typeof seg.path === 'string') {
      textParts.push(`[attachment: ${seg.path} (${String(seg.mimeType)})]`)
    } else if (seg.type === 'tool_use' && typeof seg.id === 'string') {
      const result = resultsById.get(seg.id)
      if (!result) continue
      items.push({ type: 'function_call', name: 'shell', arguments: JSON.stringify(seg.input ?? {}), call_id: seg.id })
      items.push({ type: 'function_call_output', call_id: seg.id, output: truncate(JSON.stringify(result.content ?? ''), TOOL_OUTPUT_CHAR_CAP) })
    }
    // thinking / result / error / tool_result → not replayed
  }
  const text = textParts.join('\n')
  if (text.trim().length > 0) {
    items.push({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
  }
  return items
}

/**
 * Build the replayed conversation input from the persisted transcript. The
 * newest messages always survive; older ones drop wholesale (never splitting
 * a message, so function_call/output pairs stay intact) once the serialized
 * transcript exceeds `MAX_TRANSCRIPT_CHARS`. Exported for unit testing.
 */
export const buildApiInput = (messages: readonly ChatMessage[]): ResponseInputItem[] => {
  const perMessage = messages.map(messageToItems)
  const kept: ResponseInputItem[][] = []
  let chars = 0
  for (let i = perMessage.length - 1; i >= 0; i--) {
    const items = perMessage[i]
    const size = JSON.stringify(items).length
    if (kept.length > 0 && chars + size > MAX_TRANSCRIPT_CHARS) break
    kept.unshift(items)
    chars += size
  }
  return kept.flat()
}

/** Exponential backoff delays for throttled retries (ms). */
const THROTTLE_BACKOFF_MS = [30_000, 60_000, 120_000]

// ── Runner ────────────────────────────────────────────────────────────────────

/** 10-minute wall-clock timeout per chat run. */
export const CHAT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * ChatRunner manages in-flight Codex API runs for chat threads.
 *
 * Call `sendMessage` to start a run. The run is fire-and-forget from the
 * HTTP handler's perspective: segments are pushed live over SSE and the
 * assistant message is persisted when the run completes. Call `stop` to
 * abort a run in progress. Call `killAll` from the daemon shutdown hook to
 * abort every active run.
 */
export class ChatRunner {
  /** Map from threadId to the AbortController that can kill the active run. */
  private activeRuns = new Map<string, AbortController>()

  /**
   * Per-thread retry state for throttled runs.
   * `retryCount` tracks how many backoff retries have fired so far;
   * `timer` is the pending timeout handle so `stop()` can cancel it.
   */
  private throttledRetries = new Map<string, { retryCount: number; timer: ReturnType<typeof setTimeout> }>()

  /**
   * True when the most recent auth failure was observed. A single global flag
   * because one OAuth token backs all threads.
   */
  private codexAuthFailed = false

  /** Listeners notified when the auth-failure state changes. */
  private authListeners: Array<(failed: boolean) => void> = []

  /**
   * Tracks the in-flight `_run` promise for each thread so `shutdownDrain`
   * can wait for them to finalise before the daemon exits.
   */
  private _activeRunPromises = new Map<string, Promise<void>>()

  /**
   * When set, an aborted run that has accumulated no text segments will use
   * this value as its assistant reply instead of the default `[no output]`.
   * Set by `shutdownDrain` before aborting runs.
   */
  private _shutdownMessage: string | null = null

  /**
   * @param chatStreamHub Optional per-thread `UIMessageChunk` source backing the
   *   `GET /chat/threads/:id/ui-stream` route. When present, the runner mirrors
   *   every streamed segment into it (mapped + buffered for resume); when absent
   *   (e.g. a bare `new ChatRunner()` in a unit test), streaming is a no-op.
   */
  constructor(private readonly chatStreamHub?: ChatStreamHub) {}

  /** Returns true when all threads are stalled due to a Codex auth failure. */
  isAuthFailed(): boolean {
    return this.codexAuthFailed
  }

  /**
   * Clear the global auth-failure flag and re-queue all throttled threads.
   * Call this after the user has re-authenticated so stalled threads resume.
   */
  clearAuthFailure(repoRoot: string, hub: ViewStreamHub | undefined): void {
    if (!this.codexAuthFailed) return
    this.codexAuthFailed = false
    for (const listener of this.authListeners) listener(false)

    // Re-queue every throttled thread immediately.
    for (const [threadId, retry] of this.throttledRetries) {
      clearTimeout(retry.timer)
      this.throttledRetries.delete(threadId)
      const abort = new AbortController()
      this.activeRuns.set(threadId, abort)
      const runPromise = this._run(threadId, '', repoRoot, hub, abort, undefined, 0)
        .catch(() => { this.activeRuns.delete(threadId) })
        .finally(() => { this._activeRunPromises.delete(threadId) })
      this._activeRunPromises.set(threadId, runPromise)
    }
  }

  /** Subscribe to auth-failure state changes. */
  onAuthStateChange(listener: (failed: boolean) => void): () => void {
    this.authListeners.push(listener)
    return () => {
      this.authListeners = this.authListeners.filter((l) => l !== listener)
    }
  }

  /**
   * Start a Codex run for `threadId`. Returns `{ alreadyRunning: true }`
   * without starting if there is already an active run for that thread
   * (the HTTP layer should respond 409). Otherwise starts the run
   * asynchronously and returns `{ alreadyRunning: false }`.
   *
   * When `attachments` are provided, they are persisted as `attachment`
   * segments on the user message and their paths/types are appended to the
   * prompt so the agent can read or process them.
   */
  async sendMessage(
    threadId: string,
    content: string,
    repoRoot: string,
    hub: ViewStreamHub | undefined,
    attachments?: AttachmentInfo[],
  ): Promise<{ alreadyRunning: boolean }> {
    if (this.activeRuns.has(threadId)) return { alreadyRunning: true }
    // If there's a pending throttle timer for this thread, cancel it and
    // treat the new sendMessage as an immediate re-run instead.
    const pending = this.throttledRetries.get(threadId)
    if (pending) {
      clearTimeout(pending.timer)
      this.throttledRetries.delete(threadId)
    }

    const abort = new AbortController()
    this.activeRuns.set(threadId, abort)

    // Fire-and-forget: HTTP responds immediately; segments arrive via SSE.
    // Track the promise so shutdownDrain() can await completion before exit.
    const runPromise = this._run(threadId, content, repoRoot, hub, abort, attachments, 0)
      .catch(() => {
        // Ensure the map entry is removed even if _run throws unexpectedly.
        this.activeRuns.delete(threadId)
      })
      .finally(() => {
        this._activeRunPromises.delete(threadId)
      })
    this._activeRunPromises.set(threadId, runPromise)

    return { alreadyRunning: false }
  }

  /**
   * Kill the active run for `threadId`. Returns `true` when a run or pending
   * throttle retry was found and cancelled, `false` when the thread was idle.
   */
  stop(threadId: string): boolean {
    const retry = this.throttledRetries.get(threadId)
    if (retry) {
      clearTimeout(retry.timer)
      this.throttledRetries.delete(threadId)
      // Flip the DB status back to idle.
      setThreadStatus(threadId, 'idle').catch(() => {})
      return true
    }
    const ctrl = this.activeRuns.get(threadId)
    if (!ctrl) return false
    ctrl.abort()
    return true
  }

  /**
   * Abort every active run. Called by the daemon shutdown hook to ensure all
   * in-flight requests and tool subprocesses are killed before the daemon
   * exits.
   */
  killAll(): void {
    for (const ctrl of this.activeRuns.values()) {
      ctrl.abort()
    }
    for (const retry of this.throttledRetries.values()) {
      clearTimeout(retry.timer)
    }
    this.throttledRetries.clear()
  }

  /**
   * Gracefully drain all active chat runs before daemon shutdown.
   *
   * For each in-flight run:
   * - Cancels pending throttle timers (their retries won't happen post-shutdown).
   * - Aborts each run so `_run` can reach its abort path and call
   *   `finalize()` with whatever segments it has accumulated.
   * - If a run has accumulated no text segments, `message` is written as the
   *   assistant reply so the thread does not end with the default `[no output]`.
   *
   * Waits up to `timeoutMs` for all runs to finalise (bounded by the same
   * wall-clock cap individual runs carry). After the timeout, `killAll()`
   * should be called as a safety net for any runs that did not settle.
   */
  async shutdownDrain(message: string, timeoutMs: number): Promise<void> {
    if (this.activeRuns.size === 0 && this.throttledRetries.size === 0) return
    this._shutdownMessage = message
    // Clear throttle timers — their retries will not run after shutdown.
    for (const retry of this.throttledRetries.values()) clearTimeout(retry.timer)
    this.throttledRetries.clear()
    // Abort all active runs so their _run calls reach finalize().
    for (const ctrl of this.activeRuns.values()) ctrl.abort()
    // Wait for all tracked _run promises to settle, bounded by timeoutMs.
    const promises = Array.from(this._activeRunPromises.values())
    if (promises.length === 0) return
    await Promise.race([
      Promise.allSettled(promises),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ])
  }

  // ── Internal run orchestration ─────────────────────────────────────────────

  /**
   * Park a thread in `'throttled'` status and schedule a retry after the
   * appropriate backoff interval. After `THROTTLE_BACKOFF_MS.length` retries
   * the thread is finalised with an error segment so it does not retry forever.
   */
  private async _scheduleThrottle(
    threadId: string,
    content: string,
    repoRoot: string,
    hub: ViewStreamHub | undefined,
    attachments: AttachmentInfo[] | undefined,
    retryCount: number,
  ): Promise<void> {
    this.activeRuns.delete(threadId)

    if (retryCount >= THROTTLE_BACKOFF_MS.length) {
      // Exhausted retries — surface a terminal error.
      await setThreadStatus(threadId, 'idle')
      await appendMessage(
        threadId,
        'assistant',
        'Codex is temporarily unavailable. Please try again later.',
        [{ type: 'error', message: 'Codex is temporarily unavailable (rate/usage limit). Retries exhausted.' }],
      )
      hub?.broadcast('chat')
      return
    }

    await setThreadStatus(threadId, 'throttled')
    hub?.broadcast('chat')

    const delay = THROTTLE_BACKOFF_MS[retryCount]
    const timer = setTimeout(() => {
      this.throttledRetries.delete(threadId)
      const abort = new AbortController()
      this.activeRuns.set(threadId, abort)
      const runPromise = this._run(threadId, content, repoRoot, hub, abort, attachments, retryCount + 1)
        .catch(() => { this.activeRuns.delete(threadId) })
        .finally(() => { this._activeRunPromises.delete(threadId) })
      this._activeRunPromises.set(threadId, runPromise)
    }, delay)
    this.throttledRetries.set(threadId, { retryCount, timer })
  }

  private async _run(
    threadId: string,
    content: string,
    repoRoot: string,
    hub: ViewStreamHub | undefined,
    abort: AbortController,
    attachments: AttachmentInfo[] | undefined,
    retryCount: number,
  ): Promise<void> {
    const accumulatedSegments: ChatSegment[] = []
    const broadcastSegment = (seg: ChatSegment): void => {
      if (seg.type === 'text' && seg.text.length === 0) return
      accumulatedSegments.push(seg)
      // Live UIMessage-chunk streaming: the hub maps + buffers each segment for
      // GET /chat/threads/:id/ui-stream (replacing the old `chat-delta` carrier
      // that the client transport used to map itself).
      this.chatStreamHub?.publish(threadId, seg)
    }

    const finalize = async (extraSeg?: ChatSegment): Promise<void> => {
      this.activeRuns.delete(threadId)
      if (extraSeg) {
        accumulatedSegments.push(extraSeg)
        this.chatStreamHub?.publish(threadId, extraSeg)
      }
      // Seal the UIMessage-chunk stream so connected clients settle. A `result`
      // or `error` segment already emitted the terminal `finish`; otherwise
      // (e.g. a manual stop) this emits `finish` with reason `stop`.
      this.chatStreamHub?.finishRun(threadId)
      // Build a plain-text content from all text segments for the message body.
      const textContent = accumulatedSegments
        .filter((s): s is { type: 'text'; text: string } => s.type === 'text')
        .map((s) => s.text)
        .join('')
      await appendMessage(
        threadId,
        'assistant',
        textContent.length > 0 ? textContent : '[no output]',
        accumulatedSegments,
      )
      await setThreadStatus(threadId, 'idle')
      // Invalidation ping so the sidebar re-fetches the thread list.
      hub?.broadcast('chat')
    }

    // Open the UIMessage-chunk buffer up-front so EVERY exit path (including an
    // early error before the first request) streams into a live run that
    // connected clients can settle on. The POST that triggered this run already
    // returned 202, so the ui-stream is the client's only channel for outcomes.
    this.chatStreamHub?.startRun(threadId)

    try {
      // Fetch thread for transcript and existence check.
      const threadData = await getThread(threadId)
      if (!threadData) {
        this.activeRuns.delete(threadId)
        this.chatStreamHub?.finishRun(threadId)
        return
      }

      const hasMessages = threadData.messages.length > 0

      // Build user segments: always start with a text segment, then append one
      // attachment segment per uploaded file so the UI can render them.
      const userSegments: ChatSegment[] = [{ type: 'text', text: content }]
      let promptContent = content

      if (attachments && attachments.length > 0) {
        const promptLines: string[] = []
        for (const att of attachments) {
          const kindHint: 'image' | 'audio' | 'video' = IMAGE_MIMES.has(att.mimeType)
            ? 'image'
            : AUDIO_MIMES.has(att.mimeType)
              ? 'audio'
              : 'video'
          userSegments.push({ type: 'attachment', path: att.path, mimeType: att.mimeType, name: att.name, size: att.size, kindHint })
          if (kindHint === 'image') {
            promptLines.push(`The user attached image ${att.path} — read it with the shell tool.`)
          } else {
            promptLines.push(
              `The user attached ${kindHint} file ${att.path} (${att.mimeType}) — the agent may use local tools (e.g. ffmpeg) to inspect or transcode it; the model cannot natively hear or watch it.`,
            )
          }
        }
        promptContent = `${content}\n\n---\n${promptLines.join('\n')}\n---`
      }

      // Persist the user message with typed segments so the UI can render it.
      // On throttle retries (retryCount > 0), the user message was already
      // persisted on the first attempt — skip to avoid duplicates.
      if (retryCount === 0 && content.length > 0) {
        await appendMessage(threadId, 'user', content, userSegments)
      }

      // Auto-title: set the thread title to the first user message (≤60 chars)
      // when the thread has no title and no prior messages.
      if (!threadData.thread.title && !hasMessages) {
        const title = content.slice(0, 60)
        await updateThreadTitle(threadId, title)
        hub?.broadcast('chat')
      }

      // Mark thread as running.
      await setThreadStatus(threadId, 'running')
      hub?.broadcast('chat')

      // Replay the persisted transcript as conversation input. On a throttle
      // retry the current user message is already persisted — drop it from the
      // replay so the attachment-augmented prompt below isn't duplicated.
      let transcript: readonly ChatMessage[] = threadData.messages
      if (retryCount > 0 && content.length > 0) {
        const last = transcript.at(-1)
        if (last && last.role === 'user') transcript = transcript.slice(0, -1)
      }
      const input: ResponseInputItem[] = buildApiInput(transcript)
      if (content.length > 0) {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: promptContent }] })
      }

      // Arm the wall-clock timeout.
      let isTimeout = false
      const timer = setTimeout(() => {
        isTimeout = true
        abort.abort()
      }, CHAT_TIMEOUT_MS)

      try {
        const instructions = await resolveChatSystemPrompt(repoRoot)
        let auth: CodexAuth = await loadCodexAuth()
        let authRetried = false

        // Aggregate usage across all tool-loop round-trips into one result segment.
        let sawUsage = false
        const usageTotals = { input: 0, output: 0, cached: 0 }

        for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
          const pendingCalls: Array<{ callId: string; input: unknown }> = []

          for (;;) {
            pendingCalls.length = 0
            try {
              await streamCodexResponse({
                auth,
                model: CHAT_MODEL,
                instructions,
                input,
                tools: [SHELL_TOOL],
                signal: abort.signal,
                onEvent: (event) => {
                  for (const seg of parseEventToSegments(event)) {
                    if (seg.type === 'result') {
                      sawUsage = true
                      usageTotals.input += seg.inputTokens ?? 0
                      usageTotals.output += seg.outputTokens ?? 0
                      usageTotals.cached += seg.cacheReadTokens ?? 0
                      continue
                    }
                    broadcastSegment(seg)
                    if (seg.type === 'tool_use') pendingCalls.push({ callId: seg.id, input: seg.input })
                  }
                },
              })
              break
            } catch (err) {
              // One silent token refresh per run before surfacing the auth banner.
              if (err instanceof CodexApiError && err.kind === 'auth' && !authRetried) {
                authRetried = true
                auth = await refreshCodexAuth(auth)
                continue
              }
              throw err
            }
          }

          if (abort.signal.aborted || pendingCalls.length === 0) break

          for (const call of pendingCalls) {
            const args = isObject(call.input) ? call.input : {}
            const command = typeof args.command === 'string' ? args.command : null
            let output: { stdout: string; stderr: string; exitCode: number }
            if (command === null) {
              output = { stdout: '', stderr: 'invalid shell arguments: missing "command"', exitCode: 1 }
            } else {
              const r = await runSubprocessStreaming(
                'bash', ['-lc', command], repoRoot, undefined, abort.signal, buildWorkerEnv(),
              )
              output = {
                stdout: truncate(r.stdout, TOOL_OUTPUT_CHAR_CAP),
                stderr: truncate(r.stderr, TOOL_OUTPUT_CHAR_CAP),
                exitCode: r.exitCode,
              }
            }
            broadcastSegment({ type: 'tool_result', tool_use_id: call.callId, content: output, isError: output.exitCode !== 0 })
            input.push({ type: 'function_call', name: 'shell', arguments: JSON.stringify(args), call_id: call.callId })
            input.push({ type: 'function_call_output', call_id: call.callId, output: JSON.stringify(output) })
            if (abort.signal.aborted) break
          }
          if (abort.signal.aborted) break
        }

        if (!abort.signal.aborted && sawUsage) {
          broadcastSegment({
            type: 'result',
            durationMs: null,
            inputTokens: usageTotals.input,
            outputTokens: usageTotals.output,
            cacheReadTokens: usageTotals.cached,
            cost: null,
          })
        }
      } catch (err) {
        clearTimeout(timer)

        if (isTimeout) {
          await finalize({ type: 'error', message: 'Run timed out after 10 minutes' })
          return
        }
        if (abort.signal.aborted) {
          // When the daemon is shutting down and no text was produced yet,
          // surface the shutdown notice so the thread doesn't end with
          // "[no output]".
          const shutdownMsg = this._shutdownMessage
          if (shutdownMsg && !accumulatedSegments.some((s) => s.type === 'text')) {
            await finalize({ type: 'text', text: shutdownMsg })
          } else {
            await finalize()
          }
          return
        }

        if (err instanceof CodexApiError) {
          // ── Auth failure: surface a single global banner, set throttled. ────
          if (err.kind === 'auth') {
            if (!this.codexAuthFailed) {
              this.codexAuthFailed = true
              for (const listener of this.authListeners) listener(true)
            }
            await this._scheduleThrottle(threadId, content, repoRoot, hub, attachments, retryCount)
            return
          }
          // ── Rate/usage limit: throttle + auto-retry with backoff. ───────────
          if (err.kind === 'rate-limit') {
            await this._scheduleThrottle(threadId, content, repoRoot, hub, attachments, retryCount)
            return
          }
          // ── http/network: terminal error (user-safe, no provider details). ──
          await finalize({
            type: 'error',
            message: 'Codex could not complete this response. Try again; if it continues, check the local Codex auth and network.',
          })
          return
        }
        throw err
      }
      clearTimeout(timer)

      if (isTimeout) {
        await finalize({ type: 'error', message: 'Run timed out after 10 minutes' })
        return
      }

      if (abort.signal.aborted) {
        const shutdownMsg = this._shutdownMessage
        if (shutdownMsg && !accumulatedSegments.some((s) => s.type === 'text')) {
          await finalize({ type: 'text', text: shutdownMsg })
        } else {
          await finalize()
        }
        return
      }

      if (!accumulatedSegments.some((seg) => seg.type === 'text')) {
        await finalize({ type: 'error', message: 'Codex completed without a chat response. Try again.' })
        return
      }

      await finalize()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Best-effort finalisation — may itself fail if the DB is gone.
      try {
        await finalize({ type: 'error', message: msg })
      } catch {
        this.activeRuns.delete(threadId)
        await setThreadStatus(threadId, 'idle').catch(() => {})
      }
    }
  }
}
