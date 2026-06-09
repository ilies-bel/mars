// pty runtime dispatcher — drives an agent CLI under node-pty so interactive
// harnesses (e.g. Claude Code's native TTY mode) run without -p headless
// mode. The returned RunClaudeResult is shape-compatible with runClaudeCode so
// the verify/merge pipeline sees no difference.
//
// See PRD 4cf68f4f — slice 7/13.

import { spawnPty } from '../lib/pty/spawn'
import type { Provider } from './providers'
import type { RunClaudeResult } from '../lib/git/claude'

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
 */
export const runPtySession = async (args: RunPtySessionArgs): Promise<RunClaudeResult> => {
  const { provider, prompt, cwd, sessionId, externalAbort, model } = args

  const argv = provider.spawnArgv({ sessionId, model })
  const [cmd, ...rest] = argv as string[]
  const handle = spawnPty(cmd!, rest, { cwd })

  await provider.feedPrompt(handle, prompt)

  let exitCode = 0

  // AbortController that lets us cancel the done-signal watcher when the
  // external abort fires first, so the watcher's internal resources are freed.
  const innerAbort = new AbortController()

  // Settle on the Provider's done-signal if one is registered, otherwise fall
  // back to waiting for the pty process to exit naturally.
  // Narrow the ProviderDoneSignal union: only 'status-file' exposes a wait()
  // method; 'prompt-scan' signals are detected by scanning the pty buffer
  // (reserved for a future slice). Both unrecognised kinds fall through to
  // process-exit.
  const ds = provider.doneSignal
  const waitDone: Promise<void> =
    ds?.kind === 'status-file'
      ? ds.wait(sessionId ?? '', cwd, innerAbort.signal)
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
    } else {
      await waitDone
    }
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'AbortError') {
      exitCode = 137
    } else {
      exitCode = 1
    }
  }

  handle.kill('SIGTERM')

  return {
    exitCode,
    stdout: handle.buffer(),
    stderr: '',
    sessionId: sessionId ?? null,
    conversation: [],
  }
}
