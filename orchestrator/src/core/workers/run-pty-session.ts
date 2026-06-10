// pty runtime dispatcher — drives an agent CLI under node-pty so interactive
// harnesses (e.g. Claude Code's native TTY mode) run without -p headless
// mode. The returned RunClaudeResult is shape-compatible with runClaudeCode so
// the verify/merge pipeline sees no difference.
//
// See PRD 4cf68f4f — slice 7/13.

import fs from 'node:fs'
import path from 'node:path'
import { spawnPty } from '../lib/pty/spawn'
import type { Provider } from './providers'
import type { RunClaudeResult } from '../lib/git/claude'
import { watchPromptScan } from './prompt-scan-done'

export interface RunPtySessionArgs {
  readonly provider: Provider
  readonly prompt: string
  readonly cwd: string
  readonly sessionId?: string
  readonly externalAbort?: AbortSignal
  readonly model: string
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
  const { provider, prompt, cwd, sessionId, externalAbort, model } = args

  // Set up trace logging under <cwd>/.mars/pty/
  const logDir = path.join(cwd, '.mars', 'pty')
  fs.mkdirSync(logDir, { recursive: true })
  const fileId = sessionId ?? 'anon'
  const rawLog = fs.createWriteStream(path.join(logDir, `${fileId}.log`), { flags: 'a' })
  const eventLog = fs.createWriteStream(path.join(logDir, `${fileId}.events.jsonl`), { flags: 'a' })
  const writeEvent = (event: string): void => {
    eventLog.write(JSON.stringify({ ts: new Date().toISOString(), event }) + '\n')
  }

  try {
    // If the provider needs pre-spawn setup (e.g. the claude Stop hook that
    // enables the status-file done-signal), run it now — before the process
    // starts so the hook is in place for the very first turn.
    if (sessionId !== undefined) {
      provider.prepare?.(cwd, sessionId)
    }

    const argv = provider.spawnArgv({ sessionId, model })
    const [cmd, ...rest] = argv as string[]
    const handle = spawnPty(cmd!, rest, { cwd })

    // Stream raw pty output to the log file
    handle.onData((chunk: string) => {
      rawLog.write(chunk)
    })

    writeEvent('started')
    await provider.feedPrompt(handle, prompt)
    writeEvent('prompt-fed')

    let exitCode = 0
    let doneDetected = false

    // AbortController that lets us cancel the done-signal watcher when the
    // external abort fires first, so the watcher's internal resources are freed.
    const innerAbort = new AbortController()

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

    try {
      // Handle an already-fired abort up front so we don't enter the race.
      if (externalAbort?.aborted) {
        innerAbort.abort()
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
      }

      if (externalAbort) {
        // Race the done-signal against the external abort. The abort listener
        // cancels the inner watcher so it releases its resources promptly.
        await Promise.race([
          waitDone,
          new Promise<never>((_, reject) => {
            externalAbort.addEventListener(
              'abort',
              () => {
                innerAbort.abort()
                reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
              },
              { once: true },
            )
          }),
        ])
        doneDetected = true
      } else {
        await waitDone
        doneDetected = true
      }
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
