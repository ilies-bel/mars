/**
 * Chat runner — spawns a `claude -p` process for a given thread, streams
 * typed segments over the `chat` SSE channel, and persists the assistant
 * reply to `chat_messages` when the run finishes.
 *
 * One run per thread at a time (in-memory guard); concurrent POST requests
 * get a 409 response from the HTTP route. A 10-minute wall-clock timeout
 * finalises the run with an `error` segment. `killAll()` is called by the
 * daemon shutdown path to SIGKILL all live children.
 */

import { parseClaudeStreamLine, type ClaudeEvent } from '../lib/claude-stream'
import {
  resolveClaudeBin,
  buildWorkerEnv,
  toClaudeSessionId,
  runSubprocessStreaming,
  type RunSubprocessResult,
} from '../lib/git/claude'
import {
  appendMessage,
  getThread,
  markContextSeeded,
  setThreadSession,
  setThreadStatus,
  updateThreadTitle,
  type AlertSegment,
} from '../lib/chat-store'
import type { ViewStreamHub } from './view/stream-hub'
import { resolveChatSystemPrompt } from './chat-system-prompt'

// ── Segment types ─────────────────────────────────────────────────────────────

/**
 * A single typed segment produced by the stream-json parser. Each segment
 * maps to one recognisable unit in the Claude output: a text block, a
 * tool call, its result, the final usage summary, or an error.
 */
export type ChatSegment =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; isError: boolean }
  | { type: 'result'; durationMs: number | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cost: number | null }
  | { type: 'error'; message: string }

// ── Parser ────────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Convert a single Claude stream-json event into zero or more `ChatSegment`
 * values. The function is pure (no I/O) and exported for unit testing.
 *
 * Recognised event → segment mappings:
 * - `assistant` with text blocks       → `text`
 * - `assistant` with thinking blocks   → `thinking`
 * - `assistant` with tool_use blocks   → `tool_use`
 * - `user` with tool_result blocks     → `tool_result`
 * - `result`                           → `result` (usage + cost)
 * All other event types produce no segments.
 */
export const parseEventToSegments = (event: ClaudeEvent): ChatSegment[] => {
  const segs: ChatSegment[] = []

  if (event.type === 'assistant') {
    const msg = event.message
    if (isObject(msg) && Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (!isObject(block)) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          segs.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          segs.push({ type: 'thinking', thinking: block.thinking })
        } else if (block.type === 'tool_use') {
          segs.push({
            type: 'tool_use',
            id: typeof block.id === 'string' ? block.id : '',
            name: typeof block.name === 'string' ? block.name : '',
            input: block.input ?? null,
          })
        }
      }
    }
  } else if (event.type === 'user') {
    const msg = event.message
    if (isObject(msg) && Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (!isObject(block)) continue
        if (block.type === 'tool_result') {
          segs.push({
            type: 'tool_result',
            tool_use_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            content: block.content ?? null,
            isError: block.is_error === true,
          })
        }
      }
    }
  } else if (event.type === 'result') {
    const usage = event.usage
    segs.push({
      type: 'result',
      durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
      inputTokens:
        isObject(usage) && typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
      outputTokens:
        isObject(usage) && typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
      cacheReadTokens:
        isObject(usage) && typeof usage.cache_read_input_tokens === 'number'
          ? usage.cache_read_input_tokens
          : null,
      cost: typeof event.cost_usd === 'number' ? event.cost_usd : null,
    })
  }

  return segs
}

// ── Args builder ──────────────────────────────────────────────────────────────

/**
 * Build the `claude` argv for a chat run. Differs from the worker
 * `claudeStreamArgs` path in two ways:
 * 1. Uses `--resume` (not `--session-id`) when continuing a session so the
 *    assistant has the prior conversation context.
 * 2. Does NOT include `--no-session-persistence` so the session is saved
 *    between turns and `--resume` can pick it up.
 */
const buildChatArgs = (
  content: string,
  sessionId: string | null,
  systemPrompt: string,
): readonly string[] => {
  const base: string[] = [
    '-p',
    content,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--setting-sources',
    'project,local',
    '--append-system-prompt',
    systemPrompt,
  ]
  if (sessionId) {
    base.push('--resume', toClaudeSessionId(sessionId))
  }
  return base
}

// ── Delta tracker ─────────────────────────────────────────────────────────────

/**
 * Tracks the text head emitted so far for a single streaming assistant turn
 * and computes per-event text deltas.
 *
 * The claude CLI emits `assistant` events with *cumulative* text in each
 * content block: each event contains all assistant text generated so far, not
 * just the new chunk. `TextDeltaTracker.next()` converts that into the
 * incremental delta (text since the last emit) so the SSE client receives
 * progressive chunks rather than the full text repeated on every event.
 *
 * The tracker also handles the simpler "already-delta" format (each event
 * carries only new text) transparently: a text block that does not extend the
 * current head is treated as a fresh delta and appended.
 *
 * Exported for unit testing.
 */
export class TextDeltaTracker {
  private head = ''

  /**
   * Given the text from the latest assistant event content block (may be
   * cumulative or incremental), return only the NEW portion. Returns `''`
   * when there is nothing new to emit (e.g. a duplicate event).
   */
  next(text: string): string {
    if (text.startsWith(this.head)) {
      // Cumulative format: this event repeats everything seen so far.
      const delta = text.slice(this.head.length)
      this.head = text
      return delta
    }
    // Delta format: the text is a fresh addition, not a cumulative repeat.
    this.head += text
    return text
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

/** 10-minute wall-clock timeout per chat run. */
const CHAT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * ChatRunner manages in-flight `claude -p` runs for chat threads.
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
   * Start a claude run for `threadId`. Returns `{ alreadyRunning: true }`
   * without spawning if there is already an active run for that thread
   * (the HTTP layer should respond 409). Otherwise starts the run
   * asynchronously and returns `{ alreadyRunning: false }`.
   */
  async sendMessage(
    threadId: string,
    content: string,
    repoRoot: string,
    hub: ViewStreamHub | undefined,
  ): Promise<{ alreadyRunning: boolean }> {
    if (this.activeRuns.has(threadId)) return { alreadyRunning: true }

    const abort = new AbortController()
    this.activeRuns.set(threadId, abort)

    // Fire-and-forget: HTTP responds immediately; segments arrive via SSE.
    this._run(threadId, content, repoRoot, hub, abort).catch(() => {
      // Ensure the map entry is removed even if _run throws unexpectedly.
      this.activeRuns.delete(threadId)
    })

    return { alreadyRunning: false }
  }

  /**
   * Kill the active run for `threadId`. Returns `true` when a run was found
   * and aborted, `false` when the thread was already idle.
   */
  stop(threadId: string): boolean {
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
  }

  // ── Internal run orchestration ─────────────────────────────────────────────

  private async _run(
    threadId: string,
    content: string,
    repoRoot: string,
    hub: ViewStreamHub | undefined,
    abort: AbortController,
  ): Promise<void> {
    const accumulatedSegments: ChatSegment[] = []
    let detectedSessionId: string | null = null
    // Tracks cumulative text emitted so far for the current text stream, used
    // to compute the incremental delta broadcast via SSE on each event.
    const textDelta = new TextDeltaTracker()

    const broadcastSegment = (seg: ChatSegment): void => {
      if (seg.type === 'text') {
        // The claude CLI may emit cumulative text in each assistant event (each
        // event contains all text generated so far). Compute the delta so the
        // client receives only the new text on each SSE push.
        const delta = textDelta.next(seg.text)
        if (delta.length === 0) return // nothing new to emit
        const deltaSeg: ChatSegment = { type: 'text', text: delta }
        accumulatedSegments.push(deltaSeg)
        hub?.broadcastData('chat', { threadId, event: deltaSeg })
      } else {
        accumulatedSegments.push(seg)
        hub?.broadcastData('chat', { threadId, event: seg })
      }
    }

    const finalize = async (extraSeg?: ChatSegment): Promise<void> => {
      this.activeRuns.delete(threadId)
      if (extraSeg) accumulatedSegments.push(extraSeg)
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

    try {
      // Fetch thread for session_id and existence check.
      const threadData = await getThread(threadId)
      if (!threadData) {
        this.activeRuns.delete(threadId)
        return
      }

      const existingSessionId = threadData.thread.session_id
      const hasMessages = threadData.messages.length > 0

      // Build context preamble for the first run of this thread so the agent
      // has the alert card and conversation history when no claude session
      // exists yet (or when a previous session was lost after a daemon restart).
      let promptContent = content
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
          promptContent = `<thread_context>\n${preambleParts.join('\n\n')}\n</thread_context>\n\n${content}`
        }

        // Mark seeded before the subprocess call so a failed run does not
        // re-inject the preamble on a subsequent retry.
        await markContextSeeded(threadId)
      }

      // Persist the user message with a text segment so the UI can render it.
      await appendMessage(threadId, 'user', content, [{ type: 'text', text: content }])

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
          resolveClaudeBin(),
          buildChatArgs(promptContent, existingSessionId, systemPrompt),
          repoRoot,
          ({ stream, line }) => {
            if (stream !== 'stdout') return
            const event = parseClaudeStreamLine(line)
            if (!event) return
            // Capture session_id from any event that carries it.
            const sid = (event as { session_id?: unknown }).session_id
            if (typeof sid === 'string' && sid.length > 0) {
              detectedSessionId = sid
            }
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
        // Manual stop — finalise with what we have, no extra error segment.
        await finalize()
        return
      }

      if (subprocessResult.exitCode !== 0) {
        const detail = subprocessResult.stderr.trim() || `exit code ${subprocessResult.exitCode}`
        await finalize({ type: 'error', message: detail })
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
