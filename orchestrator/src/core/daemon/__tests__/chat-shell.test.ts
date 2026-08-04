import { afterEach, describe, expect, it, vi } from 'vitest'
import { runShellCommand } from '../chat-shell'

describe('chat shell commands', () => {
  it('runs a command and returns its stdout, stderr, and exit code', async () => {
    const result = await runShellCommand(
      'printf output; printf diagnostic >&2',
      process.cwd(),
      new AbortController().signal,
    )

    expect(result).toEqual({ stdout: 'output', stderr: 'diagnostic', exitCode: 0 })
  })

  it('preserves numeric exit codes', async () => {
    const result = await runShellCommand('exit 7', process.cwd(), new AbortController().signal)

    expect(result.exitCode).toBe(7)
  })

  it('truncates stdout at the output cap', async () => {
    const result = await runShellCommand(
      "printf '%010001d' 0",
      process.cwd(),
      new AbortController().signal,
    )

    expect(result.stdout).toHaveLength(10_000 + '…[truncated]'.length)
    expect(result.stdout).toMatch(/…\[truncated\]$/)
  })

  it('invokes zsh directly without a sandbox wrapper', async () => {
    const execFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, '', '')
      return {}
    })
    vi.resetModules()
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      execFile,
    }))
    const { runShellCommand: runShellCommandWithMock } = await import('../chat-shell')
    try {
      const signal = new AbortController().signal
      await runShellCommandWithMock('printf unconfined', '/tmp/a repo', signal)
      expect(execFile).toHaveBeenCalledWith(
        '/bin/zsh',
        ['-lc', 'printf unconfined'],
        { cwd: '/tmp/a repo', maxBuffer: 8 * 1024 * 1024, signal },
        expect.any(Function),
      )
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
