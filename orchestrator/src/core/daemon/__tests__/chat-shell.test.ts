import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSeatbeltProfile, runShellCommand } from '../chat-shell'

const sandboxExecUsable = (() => {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('chat shell confinement', () => {
  it('escapes repository paths before interpolating them into the Seatbelt profile', () => {
    const profile = buildSeatbeltProfile('/tmp/repo with spaces/"quoted") (allow default) ("')

    expect(profile).toContain('(subpath "/tmp/repo with spaces/\\"quoted\\") (allow default) (\\"")')
    expect(profile).toContain('(subpath "/tmp/repo with spaces/\\"quoted\\") (allow default) (\\"/.mars")')
    expect(profile).not.toContain('\n(allow default)\n')
    expect(profile).toContain('(allow file-read*)')
    expect(profile).toContain('(allow network-inbound (local ip "localhost:*"))')
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))')
    expect(profile).toContain('(deny default)')
  })

  it('wraps a Darwin command in sandbox-exec before invoking zsh', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
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
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      const signal = new AbortController().signal
      await runShellCommandWithMock('printf sandboxed', '/tmp/a repo', signal)
      expect(execFile).toHaveBeenCalledWith(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          expect.stringContaining('(allow file-write* (subpath "/tmp/a repo"))'),
          '/bin/zsh',
          '-lc',
          'printf sandboxed',
        ],
        { cwd: '/tmp/a repo', maxBuffer: 8 * 1024 * 1024, signal },
        expect.any(Function),
      )
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('uses an unconfined zsh fallback with a warning off macOS', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const result = await runShellCommand('printf fallback-ok', process.cwd(), new AbortController().signal)
      expect(result).toEqual({ stdout: 'fallback-ok', stderr: '', exitCode: 0 })
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('confinement is disabled'))
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
      warning.mockRestore()
    }
  })

  it('preserves numeric exits and bounded shell output', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const result = await runShellCommand(
        "printf '%010001d' 0; printf problem >&2; exit 7",
        process.cwd(),
        new AbortController().signal,
      )
      expect(result.exitCode).toBe(7)
      expect(result.stderr).toBe('problem')
      expect(result.stdout).toHaveLength(10_000 + '…[truncated]'.length)
      expect(result.stdout).toMatch(/…\[truncated\]$/)
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
      warning.mockRestore()
    }
  })

  it.skipIf(!sandboxExecUsable)('produces a Seatbelt profile accepted by sandbox-exec', async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const repo = await mkdtemp(join(tmpdir(), 'mars-chat-seatbelt-profile-'))

    expect(() =>
      execFileSync('/usr/bin/sandbox-exec', ['-p', buildSeatbeltProfile(repo), '/usr/bin/true'], {
        stdio: 'ignore',
      }),
    ).not.toThrow()
  })

  it.skipIf(process.platform === 'darwin' && !sandboxExecUsable)(
    'executes a git rev-list shell-tool request',
    async () => {
      const result = await runShellCommand(
        'git rev-list --count HEAD',
        process.cwd(),
        new AbortController().signal,
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toMatch(/^\d+\n$/)
    },
  )

  it.skipIf(!sandboxExecUsable)('permits repository writes but denies an outside write after &&', async () => {
    const { existsSync } = await import('node:fs')
    const { mkdtemp, readFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { dirname, join } = await import('node:path')
    const repo = await mkdtemp(join(tmpdir(), 'mars-chat-seatbelt-'))
    const allowed = join(repo, 'allowed.txt')
    const outside = join(dirname(repo), `outside-${Date.now()}.txt`)

    const result = await runShellCommand(
      `printf allowed > ${JSON.stringify(allowed)} && printf denied > ${JSON.stringify(outside)}`,
      repo,
      new AbortController().signal,
    )

    expect(result.exitCode).not.toBe(0)
    expect(await readFile(allowed, 'utf8')).toBe('allowed')
    expect(existsSync(outside)).toBe(false)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
