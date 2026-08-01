// pty runtime dispatcher — drives an agent CLI under node-pty so interactive
// harnesses (e.g. Claude Code's native TTY mode) run without -p headless
// mode. The returned RunClaudeResult is shape-compatible with runClaudeCode so
// the verify/merge pipeline sees no difference.
//
// See PRD 4cf68f4f — slice 7/13.

import fs from 'node:fs'
import path from 'node:path'
import { spawnPty } from '../lib/pty/spawn'
import type { Provider } from './provider-types'
import { buildWorkerEnv } from '../lib/git/claude'
import type { ClaudeEffort, ClaudePermissionMode, RunClaudeResult } from '../lib/git/claude'
import type { ClaudeEvent } from '../lib/claude-stream'
import { watchPromptScan } from './prompt-scan-done'

export interface RunPtySessionArgs {
  readonly provider: Provider
  readonly prompt: string
  readonly cwd: string
  readonly sessionId?: string
  readonly externalAbort?: AbortSignal
  readonly model: string
  /**
   * Optional event callback forwarded from the worker's RunOptions.
   *
   * The pty runtime reads a raw TTY byte stream and cannot produce the
   * fine-grained per-assistant-turn events that the headless stream-json path
   * emits. Instead, onEvent is called at the four coarse lifecycle points
   * that runPtySession already records to events.jsonl:
   *   { type: 'pty:started' }
   *   { type: 'pty:prompt-fed' }
   *   { type: 'pty:done-detected' }   — only when a done-signal fires cleanly
   *   { type: 'pty:killed' }
   *
   * These events give the UI/trace stream a coarse progress signal (far better
   * than silence) but do not carry token counts, tool calls, or assistant text.
   */
  readonly onEvent?: (event: ClaudeEvent) => void | Promise<void>
  /**
   * Soft context-token budget forwarded from the worker config.
   *
   * LIMITATION: The pty runtime reads a raw TTY byte stream and has no access
   * to the per-turn token counts that the stream-json path surfaces. Faithful
   * enforcement matching the headless path (which reads assistant-event token
   * fields and aborts at exit code 138) is NOT possible here.
   *
   * As a coarse placeholder, cumulative raw pty-output bytes are tracked and
   * the session is aborted when bytesReceived exceeds maxContextTokens × 4
   * (a rough 4 chars-per-token approximation). This guard fires late (the
   * model has already produced the tokens), will not catch cache-read tokens
   * that inflate context on the headless path, and returns exitCode 137
   * (not 138) so the coarse nature is visible to callers.
   *
   * When 0 or undefined the guard is disabled.
   *
   * TODO: implement a faithful per-turn token-budget guard for the pty path
   * (requires either a sidecar token counter or a JSON-mode wrapper).
   */
  readonly maxContextTokens?: number
  // Security/behaviour posture forwarded to provider.spawnArgv so interactive
  // sessions honour the same Worker-level constraints as headless runs.
  readonly permissionMode?: ClaudePermissionMode
  readonly effort?: ClaudeEffort
  readonly disallowedTools?: readonly string[]
  readonly agent?: string
  readonly appendSystemPrompt?: string
}

/**
 * Spawns the Provider's agent CLI under node-pty, feeds the prompt, awaits
 * the Provider's done-signal (or process exit when no done-signal is
 * registered), kills the pty, and returns a RunClaudeResult-shaped object.
 *
 * Exit codes follow the same conventions as runClaudeCode:
 *   0   — clean completion (done-signal fired)
 *   137 — aborted via externalAbort
 *   1   — unexpected error in the done-signal path
 *
 * Trace files written to <cwd>/.mars/pty/:
 *   <sessionId>.log          — raw pty byte stream (appended on every onData)
 *   <sessionId>.events.jsonl — lifecycle events with ISO timestamps
 */
export const runPtySession = async (args: RunPtySessionArgs): Promise<RunClaudeResult> => {
  const {
    provider,
    prompt,
    cwd,
    sessionId,
    externalAbort,
    model,
    onEvent,
    maxContextTokens,
    permissionMode,
    effort,
    disallowedTools,
    agent,
    appendSystemPrompt,
  } = args

  // Set up trace logging under <cwd>/.mars/pty/
  const logDir = path.join(cwd, '.mars', 'pty')
  fs.mkdirSync(logDir, { recursive: true })
  const fileId = sessionId ?? 'anon'
  const rawLog = fs.createWriteStream(path.join(logDir, `${fileId}.log`), { flags: 'a' })
  const eventLog = fs.createWriteStream(path.join(logDir, `${fileId}.events.jsonl`), { flags: 'a' })

  // Write a lifecycle event to events.jsonl and forward it to the caller's
  // onEvent callback so the UI/trace stream receives coarse progress signals.
  // NOTE: the pty runtime cannot emit fine-grained assistant-turn events; these
  // four lifecycle events are the faithful maximum for this runtime.
  const writeEvent = (event: string): void => {
    eventLog.write(JSON.stringify({ ts: new Date().toISOString(), event }) + '\n')
    void onEvent?.({ type: `pty:${event}` })
  }

  try {
    // If the provider needs pre-spawn setup (e.g. the claude Stop hook that
    // enables the status-file done-signal), run it now — before the process
    // starts so the hook is in place for the very first turn.
    if (sessionId !== undefined) {
      provider.prepare?.(cwd, sessionId)
    }

    const argv = provider.spawnArgv({
      sessionId,
      model,
      permissionMode,
      effort,
      disallowedTools,
      agent,
      appendSystemPrompt,
    })
    const [cmd, ...rest] = argv as string[]
    // Pass the sanitized worker env, NOT the inherited process.env. A daemon
    // launched from inside an interactive `claude` shell (or cmux pane) carries
    // CLAUDE*/AI_AGENT/CMUX_* identity vars; if they reach this nested `claude`
    // its recursion guard suppresses the child, which exits writing nothing —
    // verify no-ops and an empty diff merges as a false success. buildWorkerEnv()
    // strips exactly those vars while preserving PATH and ANTHROPIC_API_KEY.
    const handle = spawnPty(cmd!, rest, { cwd, env: buildWorkerEnv() })

    // AbortController that lets us cancel the done-signal watcher when an
    // abort source fires first, so the watcher's internal resources are freed.
    const innerAbort = new AbortController()

    // Coarse byte-budget guard for maxContextTokens.
    // See RunPtySessionArgs.maxContextTokens for the documented limitation —
    // this is intentionally a placeholder, NOT faithful token-budget enforcement.
    const budgetAbort = maxContextTokens ? new AbortController() : null
    let bytesReceived = 0
    const byteLimit = maxContextTokens ? maxContextTokens * 4 : 0

    // Stream raw pty output to the log file; track bytes for the budget guard.
    handle.onData((chunk: string) => {
      rawLog.write(chunk)
      if (budgetAbort && !budgetAbort.signal.aborted) {
        bytesReceived += chunk.length
        if (bytesReceived >= byteLimit) {
          // Coarse byte-size budget exceeded — abort the session.
          // NOT faithful token-budget enforcement; see RunPtySessionArgs.maxContextTokens.
          budgetAbort.abort()
        }
      }
    })

    writeEvent('started')

    // Readiness gate: if the provider declares an isReady predicate, poll the
    // ANSI-stripped pty buffer on a ~250 ms interval before sending keystrokes.
    // This prevents the prompt from landing before the interactive TUI has
    // rendered its input box (observed with claude CLI 2.1.159: typed chars
    // were visible in the buffer but the spinner never started).
    //
    // Times out after 30 s and proceeds so a detection miss degrades to the
    // previous behaviour rather than hanging forever.
    if (provider.isReady) {
      const { isReady } = provider
      // Strips ANSI escape sequences (CSI / Fe) so the predicate matches
      // visible text regardless of terminal colouring.
      const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
      const POLL_MS = 250
      const TIMEOUT_MS = 30_000

      await new Promise<void>((resolve) => {
        if (isReady(handle.buffer().replace(ANSI_RE, ''))) {
          resolve()
          return
        }
        let elapsed = 0
        const interval = setInterval(() => {
          elapsed += POLL_MS
          if (isReady(handle.buffer().replace(ANSI_RE, ''))) {
            clearInterval(interval)
            resolve()
          } else if (elapsed >= TIMEOUT_MS) {
            clearInterval(interval)
            writeEvent('ready-timeout')
            resolve()
          }
        }, POLL_MS)
      })
    }

    await provider.feedPrompt(handle, prompt)
    writeEvent('prompt-fed')

    let exitCode = 0
    let doneDetected = false

    // Settle on the Provider's done-signal if one is registered, otherwise fall
    // back to waiting for the pty process to exit naturally.
    //   status-file  — wait() watches for a sentinel file written by the Stop hook.
    //   prompt-scan  — watchPromptScan scans the pty buffer for the spinner+prompt.
    //   (none)       — fall back to process-exit.
    const ds = provider.doneSignal
    const waitDone: Promise<void> =
      ds?.kind === 'status-file'
        ? ds.wait(sessionId ?? '', cwd, innerAbort.signal)
        : ds?.kind === 'prompt-scan'
          ? watchPromptScan(handle, ds, innerAbort.signal)
          : new Promise<void>((resolve) => {
              handle.onExit(() => resolve())
            })

    // Helper: turn an AbortSignal into a rejecting racer that also cancels the
    // inner done-signal watcher so its resources are freed promptly.
    const abortRacer = (signal: AbortSignal): Promise<never> =>
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            innerAbort.abort()
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
          },
          { once: true },
        )
      })

    try {
      // Check all abort sources up front so we don't enter the race in an
      // already-aborted state.
      if (externalAbort?.aborted || budgetAbort?.signal.aborted) {
        innerAbort.abort()
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
      }

      // Race the done-signal against any active abort sources.
      const racers: Array<Promise<void | never>> = [waitDone]
      if (externalAbort) racers.push(abortRacer(externalAbort))
      if (budgetAbort) racers.push(abortRacer(budgetAbort.signal))

      await Promise.race(racers)
      doneDetected = true
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'AbortError') {
        exitCode = 137
      } else {
        exitCode = 1
      }
    }

    if (doneDetected) {
      writeEvent('done-detected')
    }

    handle.kill('SIGTERM')
    writeEvent('killed')

    return {
      exitCode,
      stdout: handle.buffer(),
      stderr: '',
      sessionId: sessionId ?? null,
      conversation: [],
      quotaRejected: null,
    }
  } finally {
    // Flush both trace streams before returning — callers can read the files
    // immediately after runPtySession resolves.
    await Promise.all([
      new Promise<void>((resolve) => rawLog.end(resolve)),
      new Promise<void>((resolve) => eventLog.end(resolve)),
    ])
  }
}
