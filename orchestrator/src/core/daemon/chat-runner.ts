/**
 * Chat runner — runs one chat turn per thread against the ChatGPT/Codex backend
 * (see codex-oauth.ts), streams typed segments over the `chat` SSE channel, and
 * persists the assistant reply to `chat_messages` when the run finishes.
 *
 * One run per thread at a time (in-memory guard); concurrent POST requests
 * get a 409 response from the HTTP route. A 10-minute wall-clock timeout
 * finalises the run with an `error` segment. `killAll()` is called by the
 * daemon shutdown path to abort all live runs.
 *
 * PROVIDER SESSIONS ARE GONE
 *
 * This used to spawn `codex exec` and lean on `codex exec resume <sessionId>` to
 * carry conversation state, which brought a session-expired recovery path and a
 * `context_seeded` one-shot preamble with it. The backend rejects `store: true`,
 * so there is no provider-side session to resume or lose: every turn replays a
 * bounded history rebuilt from `chat_messages` (chat-history.ts). A daemon
 * restart no longer costs the thread its context, and the alert block now flows
 * through history like any other message instead of needing a seeding flag.
 *
 * Error-kind handling (inlined in _run to avoid single-caller helpers):
 *   no-token / auth → global flag + throttle with backoff; clears on re-auth
 *   rate-limit      → throttle with backoff; auto-retries up to 3 times
 *   generic         → terminal error (user-safe message, no provider details)
 */

import {
  appendMessage,
  getThread,
  setThreadStatus,
  updateThreadTitle,
} from '../lib/chat-store'
import type { ViewStreamHub } from './view/stream-hub'
import type { ChatStreamHub } from './chat-stream-hub'
import { resolveChatSystemPrompt } from './chat-system-prompt'
import { buildProviderHistory, splitTrailingUserTurn } from './chat-history'
import { runCodexOAuthTurn, type CodexOAuthResult } from './codex-oauth'

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
 * A single typed segment produced by the stream-json parser. Each segment
 * maps to one recognisable unit in the Codex output: a text block, a
 * tool call, its result, the final usage summary, or an error.
 *
 * The `attachment` variant is produced by the HTTP route when the user
 * message carries file attachments. It is persisted on the user message and
 * rendered by the UI; it is NOT emitted by the Codex stream parser.
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

/** Exponential backoff delays for throttled retries (ms). */
const THROTTLE_BACKOFF_MS = [30_000, 60_000, 120_000]

// ── Runner ────────────────────────────────────────────────────────────────────

/** 10-minute wall-clock timeout per chat run. */
const CHAT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * ChatRunner manages in-flight provider turns for chat threads.
 *
 * Call `sendMessage` to start a run. The run is fire-and-forget from the
 * HTTP handler's perspective: segments are pushed live over SSE and the
 * assistant message is persisted when the run completes. Call `stop` to
 * abort a run in progress. Call `killAll` from the daemon shutdown hook to
 * abort every active run, which also aborts any in-flight shell tool call.
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
      this._run(threadId, '', repoRoot, hub, abort, undefined, 0).catch(() => {
        this.activeRuns.delete(threadId)
      })
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
   * without spawning if there is already an active run for that thread
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
    this._run(threadId, content, repoRoot, hub, abort, attachments, 0).catch(() => {
      // Ensure the map entry is removed even if _run throws unexpectedly.
      this.activeRuns.delete(threadId)
    })

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
   * Abort every active run. Called by the daemon shutdown hook so no run is
   * left streaming (and no shell tool child is left running) when the daemon
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
      this._run(threadId, content, repoRoot, hub, abort, attachments, retryCount + 1).catch(() => {
        this.activeRuns.delete(threadId)
      })
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
    const startedAt = Date.now()
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
    // early error before the subprocess) streams into a live run that connected
    // clients can settle on. The POST that triggered this run already returned
    // 202, so the ui-stream is the client's only channel for run outcomes.
    this.chatStreamHub?.startRun(threadId)

    try {
      // Fetch the thread for its history and an existence check.
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
            promptLines.push(`The user attached image ${att.path} — read it with the Read tool.`)
          } else {
            promptLines.push(
              `The user attached ${kindHint} file ${att.path} (${att.mimeType}) — the agent may use local tools (e.g. ffmpeg) to inspect or transcode it; the model cannot natively hear or watch it.`,
            )
          }
        }
        promptContent = `${content}\n\n---\n${promptLines.join('\n')}\n---`
      }

      // Replay the thread as structured turns. Alert blocks and tool-call
      // summaries are folded in by `flattenMessageText`, so an alert-origin
      // thread keeps its context without a one-shot preamble.
      //
      // A trailing user turn is split off rather than replayed: on a throttle or
      // re-auth retry the current message was already persisted, and a re-queue
      // arrives with no prompt of its own and needs that text as the prompt.
      const { history, trailingUserText } = splitTrailingUserTurn(
        buildProviderHistory(threadData.messages),
      )
      const effectivePrompt = promptContent.length > 0 ? promptContent : (trailingUserText ?? '')

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

      // Arm the wall-clock timeout.
      let isTimeout = false
      const timer = setTimeout(() => {
        isTimeout = true
        abort.abort()
      }, CHAT_TIMEOUT_MS)

      // The system prompt is the request's stable cache prefix — nothing
      // per-run may be prepended to it or the prefix cache misses every turn.
      const systemPrompt = await resolveChatSystemPrompt(repoRoot)

      let result: CodexOAuthResult
      try {
        result = await runCodexOAuthTurn({
          systemPrompt,
          history,
          prompt: effectivePrompt,
          cwd: repoRoot,
          signal: abort.signal,
          onSegment: broadcastSegment,
        })
      } finally {
        clearTimeout(timer)
      }

      if (isTimeout) {
        await finalize({ type: 'error', message: 'Run timed out after 10 minutes' })
        return
      }

      if (abort.signal.aborted) {
        // Manual stop — finalise with what we have, no extra error segment.
        await finalize()
        return
      }

      if (!result.ok) {
        // ── Missing or rejected credentials: one global banner, then throttle.
        //    Both land here because the remedy is identical (`codex login`), and
        //    `clearAuthFailure` re-queues every parked thread once it succeeds. ─
        if (result.kind === 'no-token' || result.kind === 'auth') {
          if (!this.codexAuthFailed) {
            this.codexAuthFailed = true
            for (const listener of this.authListeners) listener(true)
          }
          await this._scheduleThrottle(threadId, content, repoRoot, hub, attachments, retryCount)
          return
        }

        // ── Rate/usage limit: throttle + auto-retry with backoff. ────────────────
        if (result.kind === 'rate-limit') {
          await this._scheduleThrottle(threadId, content, repoRoot, hub, attachments, retryCount)
          return
        }

        // ── Generic: terminal error. The provider message may echo prompt or
        //    account details, so surface a fixed user-safe string instead. ───────
        await finalize({
          type: 'error',
          message: 'Codex could not complete this response. Try again; if it continues, check the local Codex setup.',
        })
        return
      }

      if (!accumulatedSegments.some((seg) => seg.type === 'text')) {
        await finalize({ type: 'error', message: 'Codex completed without a chat response. Try again.' })
        return
      }

      // Usage is only known once the turn (including tool round-trips) is done,
      // so the terminal `result` segment is emitted here rather than mid-stream.
      await finalize({
        type: 'result',
        durationMs: Date.now() - startedAt,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: result.usage.cachedInputTokens,
        cost: null,
      })
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
