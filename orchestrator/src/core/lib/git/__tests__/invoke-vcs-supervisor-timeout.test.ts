/**
 * Unit tests for the `invokeVcsSupervisor` timeout / subprocess-kill fix.
 *
 * Before the fix `invokeVcsSupervisor` used `Promise.race` to resolve after
 * `timeoutMs` but never killed the spawned `claude` subprocess — it kept
 * running in the background and could race against the `git rebase --abort`
 * that `mergeBranch` issued immediately after the race resolved.
 *
 * After the fix the subprocess receives an `AbortSignal`; when the timer
 * fires the signal is aborted (which sends SIGKILL via `runSubprocessStreaming`'s
 * `onAbort` handler) and the function returns the conventional timeout
 * sentinel `{exitCode: 124, ...}`.
 *
 * We test:
 *  1. The function returns `{exitCode: 124}` when the timeout fires.
 *  2. The AbortSignal passed to `runSubprocessStreaming` is aborted by the
 *     timeout (i.e. the subprocess would be killed on a real binary).
 *  3. The function returns the subprocess result unchanged when the subprocess
 *     exits before the timeout.
 */
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Capture the AbortSignal passed to runSubprocessStreaming so tests can
// assert on it. Paths are relative to THIS file's location (inside __tests__/).
// ---------------------------------------------------------------------------

let capturedSignal: AbortSignal | undefined

vi.mock('../claude', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../claude')>()
  return {
    ...orig,
    resolveClaudeBin: () => 'node',
    claudeStreamArgs: (_prompt: string) => ['-e', 'setTimeout(()=>{},60000)'],
    buildWorkerEnv: () => process.env,
    runSubprocessStreaming: vi.fn(
      (
        _cmd: string,
        _args: readonly string[],
        _cwd: string,
        _onLine: unknown,
        signal?: AbortSignal,
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        capturedSignal = signal
        // Simulate a subprocess that never exits on its own.
        // Resolves only when the AbortSignal fires (the timeout kills it).
        return new Promise((resolve) => {
          if (!signal) {
            // Should not happen — guard defensively.
            return
          }
          if (signal.aborted) {
            resolve({ exitCode: 137, stdout: '', stderr: '' })
            return
          }
          signal.addEventListener(
            'abort',
            () => resolve({ exitCode: 137, stdout: '', stderr: '' }),
            { once: true },
          )
        })
      },
    ),
  }
})

// Override the fs/promises readFile so loadSupervisorSpec succeeds without
// a real vcs-supervisor.md file on disk.
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...orig,
    readFile: vi.fn().mockResolvedValue('# fake vcs-supervisor spec\n'),
  }
})

// stub moduleDir so loadSupervisorSpec tries a predictable path.
vi.mock('../internal', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../internal')>()
  return { ...orig, moduleDir: () => '/tmp/fake-module-dir' }
})

import { invokeVcsSupervisor } from '../merge'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('invokeVcsSupervisor — timeout kills subprocess', () => {
  it('returns exitCode: 124 when timeout fires before subprocess exits', async () => {
    capturedSignal = undefined
    const timeoutMs = 100

    const result = await invokeVcsSupervisor(
      'task/feat',
      'main',
      '/tmp/fake-cwd',
      timeoutMs,
    )

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain('timed out after')
    expect(result.stderr).toContain(String(timeoutMs))
  })

  it('aborts the AbortSignal passed to runSubprocessStreaming within timeoutMs', async () => {
    capturedSignal = undefined
    const timeoutMs = 100
    const start = Date.now()

    await invokeVcsSupervisor(
      'task/feat',
      'main',
      '/tmp/fake-cwd',
      timeoutMs,
    )

    // The signal must have been set and aborted.
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(true)

    // The call must complete within a generous budget (20× the timeout),
    // not hang indefinitely.
    expect(Date.now() - start).toBeLessThan(timeoutMs * 20)
  })

  it('returns the subprocess result when it exits before the timeout', async () => {
    // Swap the mock to resolve immediately (fast exit, before timeout).
    const { runSubprocessStreaming } = await import('../claude')
    vi.mocked(runSubprocessStreaming).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"type":"result"}',
      stderr: '',
    })

    const result = await invokeVcsSupervisor(
      'task/feat',
      'main',
      '/tmp/fake-cwd',
      60_000, // long timeout — subprocess exits first
    )

    expect(result.exitCode).toBe(0)
    // Sentinel must NOT be returned for a clean exit.
    expect(result.exitCode).not.toBe(124)
  })
})
