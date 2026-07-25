/**
 * Chat runner — spawns a Codex CLI process for a given thread, streams
 * typed segments over the `chat` SSE channel, and persists the assistant
 * reply to `chat_messages` when the run finishes.
 *
 * One run per thread at a time (in-memory guard); concurrent POST requests
 * get a 409 response from the HTTP route. A 10-minute wall-clock timeout
 * finalises the run with an `error` segment. `killAll()` is called by the
 * daemon shutdown path to SIGKILL all live children.
 *
 * Error-kind handling (inlined in _run to avoid single-caller helpers):
 *   not-found (exit 127) → terminal error (no Codex binary)
 *   auth                 → global flag + throttle with backoff; clears on re-auth
 *   rate-limit           → throttle with backoff; auto-retries up to 3 times
 *   session-expired      → resetThreadSession + one silent auto-retry
 *   generic              → terminal error (user-safe message, no provider details)
 */

import {
  buildWorkerEnv,
  runSubprocessStreaming,
  type RunSubprocessResult,
} from '../lib/git/claude'
import {
  appendMessage,
  getThread,
  markContextSeeded,
  resetThreadSession,
  setThreadSession,
  setThreadStatus,
  updateThreadTitle,
  type AlertSegment,
} from '../lib/chat-store'
import type { ViewStreamHub } from './view/stream-hub'
import type { ChatStreamHub } from './chat-stream-hub'
import { resolveChatSystemPrompt } from './chat-system-prompt'

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
 * Convert a single Codex JSONL event into zero or more `ChatSegment`
 * values. The function is pure (no I/O) and exported for unit testing.
 *
 * Recognised event → segment mappings:
 * - `item.completed(agent_message)`          → `text`
 * - `item.completed(command_execution)`      → `tool_use`
 * - `item.completed(command_execution_output)` → `tool_result`
 * - `turn.completed`                         → `result` (usage)
 * All other event types produce no segments.
 */
export const parseEventToSegments = (event: unknown): ChatSegment[] => {
  const segs: ChatSegment[] = []
  if (!isObject(event)) return segs

  if (event.type === 'item.completed' && isObject(event.item)) {
    const item = event.item
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      segs.push({ type: 'text', text: item.text })
    } else if (item.type === 'command_execution' && typeof item.command === 'string') {
      segs.push({
        type: 'tool_use',
        id: typeof item.id === 'string' ? item.id : String(item.id ?? ''),
        name: deriveCommandName(item.command),
        input: { command: item.command, cwd: typeof item.cwd === 'string' ? item.cwd : undefined },
      })
    } else if (item.type === 'command_execution_output' && typeof item.tool_use_id === 'string') {
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : 0
      segs.push({
        type: 'tool_result',
        tool_use_id: item.tool_use_id,
        content: {
          stdout: typeof item.stdout === 'string' ? item.stdout : '',
          stderr: typeof item.stderr === 'string' ? item.stderr : '',
          exitCode,
        },
        isError: exitCode !== 0,
      })
    }
  } else if (event.type === 'turn.completed') {
    const usage = event.usage
    segs.push({
      type: 'result',
      durationMs: null,
      inputTokens: isObject(usage) && typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
      outputTokens: isObject(usage) && typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
      cacheReadTokens: isObject(usage) && typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : null,
      cost: null,
    })
  }

  return segs
}

// ── Args builder ──────────────────────────────────────────────────────────────

/**
 * Build a Codex CLI invocation for a chat turn. The first turn stores the
 * session automatically; later turns use `codex exec resume` with that ID.
 *
 * Exported for unit testing.
 */
export const buildChatArgs = (
  content: string,
  sessionId: string | null,
  systemPrompt: string,
): readonly string[] => {
  if (sessionId) {
    return [
      'exec', 'resume', '--json', '--model', 'gpt-5.5',
      '-c', 'model_reasoning_effort="high"',
      // Keep loopback reachable on resume turns too — see the network_access
      // note on the first-turn branch below.
      '-c', 'sandbox_workspace_write.network_access=true',
      sessionId, content,
    ]
  }
  return [
    'exec', '--json', '--model', 'gpt-5.5',
    '-c', 'model_reasoning_effort="high"', '--sandbox', 'workspace-write',
    // The chat agent's whole job is orchestration work — running `mars`
    // commands and querying the daemon/Postgres over loopback. Codex's
    // workspace-write sandbox denies network by default, which also blocks
    // the mars CLI's Unix-socket IPC bind, leaving the agent unable to reach
    // the DB at all (connect/listen EPERM on 127.0.0.1). Allow network so the
    // agent can actually do its job; writes stay confined to the workspace.
    '-c', 'sandbox_workspace_write.network_access=true',
    `${'<system_instructions>'}\n${systemPrompt}\n</system_instructions>\n\n${content}`,
  ]
}

const resolveCodexBin = (): string => process.env.MARS_CODEX_BIN?.trim() || 'codex'

/** Exponential backoff delays for throttled retries (ms). */
const THROTTLE_BACKOFF_MS = [30_000, 60_000, 120_000]

// ── Runner ────────────────────────────────────────────────────────────────────

/** 10-minute wall-clock timeout per chat run. */
export const CHAT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * ChatRunner manages in-flight Codex CLI runs for chat threads.
 *
 * Call `sendMessage` to start a run. The run is fire-and-forget from the
 * HTTP handler's perspective: segments are pushed live over SSE and the
 * assistant message is persisted when the run completes. Call `stop` to
 * abort a run in progress. Call `killAll` from the daemon shutdown hook to
 * abort every active run so their child processes are killed.
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
   * Set by `shutdownDrain` before aborting subprocesses.
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
   * child processes are killed before the daemon exits. The subprocess PIDs
   * are also tracked by `liveChildPids` in `git/claude.ts`, which the daemon
   * kill path uses as a second-level safety net.
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
   * - Aborts each subprocess so `_run` can reach its abort path and call
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
    // Abort all active subprocesses so their _run calls reach finalize().
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
    let detectedSessionId: string | null = null
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
      if (detectedSessionId) {
        await setThreadSession(threadId, detectedSessionId)
      }
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
      // Fetch thread for session_id and existence check.
      const threadData = await getThread(threadId)
      if (!threadData) {
        this.activeRuns.delete(threadId)
        this.chatStreamHub?.finishRun(threadId)
        return
      }

      const existingSessionId = threadData.thread.session_id
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

      // Build context preamble for the first run of this thread so the agent
      // has the alert card and conversation history when no Codex session
      // exists yet (or when a previous session was lost after a daemon restart).
      if (!threadData.thread.context_seeded) {
        const preambleParts: string[] = []

        // (a) Alert block when this is an alert-origin thread — render the
        //     alert segment as structured text so the agent knows the context.
        if (threadData.thread.origin === 'alert') {
          for (const msg of threadData.messages) {
            if (msg.role !== 'assistant' || !Array.isArray(msg.segments)) continue
            const alertSeg = (msg.segments as unknown[]).find(
              (s): s is AlertSegment =>
                typeof s === 'object' &&
                s !== null &&
                (s as Record<string, unknown>).type === 'alert',
            )
            if (alertSeg) {
              const actionLabels = alertSeg.actions.map((a) => a.label).join(', ')
              const alertLines = [
                `[Alert: ${alertSeg.kind}] ${alertSeg.title}`,
                `Why now: ${alertSeg.whyNow}`,
              ]
              if (actionLabels) alertLines.push(`Available actions: ${actionLabels}`)
              preambleParts.push(alertLines.join('\n'))
              break
            }
          }
        }

        // (b) Prior persisted messages — role-tagged, tool segments summarized,
        //     capped at the last 20 messages and ~8 k chars total.
        const cappedMsgs = threadData.messages.slice(-20)
        const msgLines: string[] = []
        let charCount = 0
        const CHAR_CAP = 8000
        for (const msg of cappedMsgs) {
          if (charCount >= CHAR_CAP) break
          const segs = Array.isArray(msg.segments) ? (msg.segments as unknown[]) : []
          let msgText: string
          if (segs.length > 0) {
            const parts: string[] = []
            for (const seg of segs) {
              if (typeof seg !== 'object' || seg === null) continue
              const s = seg as Record<string, unknown>
              if (s.type === 'text' && typeof s.text === 'string') {
                parts.push(s.text)
              } else if (s.type === 'tool_use') {
                const toolName =
                  typeof s.name === 'string'
                    ? s.name
                    : typeof s.toolName === 'string'
                      ? s.toolName
                      : 'unknown'
                parts.push(`used tool ${toolName}`)
              } else if (s.type === 'alert') {
                const a = s as unknown as AlertSegment
                parts.push(`[Alert: ${a.kind}] ${a.title}`)
              }
              // thinking, tool_result, result → skip; too noisy / not useful as history
            }
            msgText = parts.join(' ')
          } else {
            msgText = msg.content
          }
          if (!msgText.trim()) continue
          const remaining = CHAR_CAP - charCount
          if (msgText.length > remaining) msgText = `${msgText.slice(0, remaining)}…`
          const line = `[${msg.role}] ${msgText}`
          msgLines.push(line)
          charCount += line.length + 1
        }

        if (msgLines.length > 0) {
          preambleParts.push(`Prior conversation:\n${msgLines.join('\n')}`)
        }

        if (preambleParts.length > 0) {
          // Wrap the attachment-augmented prompt, not the raw content, so the
          // attachment block survives context seeding on a thread's first run.
          promptContent = `<thread_context>\n${preambleParts.join('\n\n')}\n</thread_context>\n\n${promptContent}`
        }

        // Mark seeded before the subprocess call so a failed run does not
        // re-inject the preamble on a subsequent retry.
        await markContextSeeded(threadId)
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

      // Arm the wall-clock timeout.
      let isTimeout = false
      const timer = setTimeout(() => {
        isTimeout = true
        abort.abort()
      }, CHAT_TIMEOUT_MS)

      const systemPrompt = await resolveChatSystemPrompt(repoRoot)

      let subprocessResult: RunSubprocessResult
      try {
        subprocessResult = await runSubprocessStreaming(
          resolveCodexBin(),
          buildChatArgs(promptContent, existingSessionId, systemPrompt),
          repoRoot,
          ({ stream, line }) => {
            if (stream !== 'stdout') return
            let event: unknown
            try { event = JSON.parse(line) } catch { return }
            if (isObject(event) && event.type === 'thread.started' && typeof event.thread_id === 'string') detectedSessionId = event.thread_id
            const segs = parseEventToSegments(event)
            for (const seg of segs) broadcastSegment(seg)
          },
          abort.signal,
          buildWorkerEnv(),
        )
      } finally {
        clearTimeout(timer)
      }

      if (isTimeout) {
        await finalize({ type: 'error', message: 'Run timed out after 10 minutes' })
        return
      }

      if (abort.signal.aborted) {
        // When the daemon is shutting down and no text was produced yet, surface
        // the shutdown notice so the thread doesn't end with "[no output]".
        const shutdownMsg = this._shutdownMessage
        if (shutdownMsg && !accumulatedSegments.some((s) => s.type === 'text')) {
          await finalize({ type: 'text', text: shutdownMsg })
        } else {
          await finalize()
        }
        return
      }

      if (subprocessResult.exitCode !== 0) {
        const detail = (subprocessResult.stderr + ' ' + subprocessResult.stdout).toLowerCase()

        // ── Session expired: clear the saved session and auto-retry once.
        //    resetThreadSession sets session_id=NULL and context_seeded=0 so
        //    the next _run picks up a fresh session and re-seeds the transcript
        //    as context preamble — no user-visible error on the first failure. ─
        if (/(session.*not found|session.*expired|invalid session|no such session)/.test(detail)) {
          await resetThreadSession(threadId)
          if (retryCount === 0) {
            // Silently retry with a fresh session.  The recursive _run will
            // re-fetch the thread (session_id now NULL) and re-inject the
            // transcript preamble (context_seeded now 0).
            const freshAbort = new AbortController()
            this.activeRuns.set(threadId, freshAbort)
            await this._run(threadId, content, repoRoot, hub, freshAbort, attachments, retryCount + 1)
            return
          }
          // Still failing after one retry — surface an error so the user knows.
          await finalize({ type: 'error', message: 'The Codex session expired and could not be resumed. Please try again.' })
          return
        }

        // ── Auth failure: surface a single global banner, set throttled. ────────
        if (subprocessResult.exitCode !== 127 && /(auth|login|credential|sign in)/.test(detail)) {
          if (!this.codexAuthFailed) {
            this.codexAuthFailed = true
            for (const listener of this.authListeners) listener(true)
          }
          await this._scheduleThrottle(threadId, content, repoRoot, hub, attachments, retryCount)
          return
        }

        // ── Rate/usage limit: throttle + auto-retry with backoff. ────────────────
        if (/(rate limit|usage limit|quota|spend limit)/.test(detail)) {
          await this._scheduleThrottle(threadId, content, repoRoot, hub, attachments, retryCount)
          return
        }

        // ── Generic / not-found: terminal error (user-safe, no provider details). ─
        const safeMessage =
          subprocessResult.exitCode === 127
            ? 'Codex is not available on this machine. Install or make the Codex CLI available, then try again.'
            : 'Codex could not complete this response. Try again; if it continues, check the local Codex setup.'
        await finalize({ type: 'error', message: safeMessage })
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
