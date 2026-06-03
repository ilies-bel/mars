import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  installWorktreeDeps,
  WorktreeInstallError,
  DEFAULT_INSTALL_TIMEOUT_MS,
} from '../worktree-install'
import type { RunSubprocessResult } from '../git/claude'

// Very short timeout so the test completes quickly.
const SHORT_TIMEOUT_MS = 200

describe('installWorktreeDeps wall-clock timeout', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(resolve(tmpdir(), 'mars-install-timeout-'))
    // Create a pnpm-lock.yaml so detectInstallSites finds one site.
    writeFileSync(resolve(workDir, 'pnpm-lock.yaml'), 'lockfileVersion: 1\n')
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('exports DEFAULT_INSTALL_TIMEOUT_MS as 8 minutes', () => {
    expect(DEFAULT_INSTALL_TIMEOUT_MS).toBe(8 * 60_000)
  })

  it('throws WorktreeInstallError with exit 137 when the runner returns exit 137', async () => {
    // Simulate a SIGKILL'd process: runner returns exit code 137.
    const runner = async (): Promise<RunSubprocessResult> => ({
      exitCode: 137,
      stdout: '',
      stderr: '',
    })

    await expect(
      installWorktreeDeps({ worktreeRoot: workDir, runner }),
    ).rejects.toBeInstanceOf(WorktreeInstallError)

    try {
      await installWorktreeDeps({ worktreeRoot: workDir, runner })
    } catch (err) {
      expect(err).toBeInstanceOf(WorktreeInstallError)
      if (err instanceof WorktreeInstallError) {
        expect(err.result.exitCode).toBe(137)
      }
    }
  })

  it('passes timeoutMs option down to the runner', async () => {
    const receivedOpts: Array<{ timeoutMs: number | undefined }> = []
    const runner = async (
      _cmd: string,
      _args: readonly string[],
      _cwd: string,
      opts?: { timeoutMs?: number },
    ): Promise<RunSubprocessResult> => {
      receivedOpts.push({ timeoutMs: opts?.timeoutMs })
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await installWorktreeDeps({
      worktreeRoot: workDir,
      runner,
      timeoutMs: SHORT_TIMEOUT_MS,
    })

    expect(receivedOpts).toHaveLength(1)
    expect(receivedOpts[0]?.timeoutMs).toBe(SHORT_TIMEOUT_MS)
  })

  it('uses DEFAULT_INSTALL_TIMEOUT_MS when no timeoutMs is supplied', async () => {
    const receivedOpts: Array<{ timeoutMs: number | undefined }> = []
    const runner = async (
      _cmd: string,
      _args: readonly string[],
      _cwd: string,
      opts?: { timeoutMs?: number },
    ): Promise<RunSubprocessResult> => {
      receivedOpts.push({ timeoutMs: opts?.timeoutMs })
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await installWorktreeDeps({ worktreeRoot: workDir, runner })

    expect(receivedOpts).toHaveLength(1)
    expect(receivedOpts[0]?.timeoutMs).toBe(DEFAULT_INSTALL_TIMEOUT_MS)
  })

  it('SIGKILLs a wedged install via AbortSignal and resolves in time', async () => {
    // Runner that honours the AbortSignal: when aborted, returns exit 137
    // (simulating what runSubprocessStreaming does on abort).
    const runner = async (
      _cmd: string,
      _args: readonly string[],
      _cwd: string,
      opts?: { timeoutMs?: number },
    ): Promise<RunSubprocessResult> => {
      const { timeoutMs } = opts ?? {}
      return new Promise((resolve) => {
        const abort = new AbortController()
        if (timeoutMs !== undefined) {
          setTimeout(() => abort.abort(), timeoutMs)
        }
        abort.signal.addEventListener('abort', () => {
          resolve({ exitCode: 137, stdout: '', stderr: 'killed by SIGKILL' })
        })
      })
    }

    const start = Date.now()
    await expect(
      installWorktreeDeps({
        worktreeRoot: workDir,
        runner,
        timeoutMs: SHORT_TIMEOUT_MS,
      }),
    ).rejects.toBeInstanceOf(WorktreeInstallError)
    const elapsed = Date.now() - start

    // Should complete within SHORT_TIMEOUT_MS + 2000ms grace.
    expect(elapsed).toBeLessThan(SHORT_TIMEOUT_MS + 2000)
  })
})
