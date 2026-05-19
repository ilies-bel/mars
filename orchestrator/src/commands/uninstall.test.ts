import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runUninstall, type UninstallPaths } from './uninstall'

// ─── shared fixtures ─────────────────────────────────────────────────────────

const fakePaths: UninstallPaths = {
  binPath: '/usr/local/bin/mars',
  srcDir: '/home/user/.mars-framework',
}

// Capture console.log / console.error during an async call.
type Captured = { out: string[]; err: string[] }

async function capturing<T>(fn: () => Promise<T>): Promise<{ result: T } & Captured> {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...args: unknown[]) => out.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => err.push(args.map(String).join(' '))
  try {
    const result = await fn()
    return { result, out, err }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

// ─── tracer bullet: entering 'y' proceeds and prints "would delete" lines ────

describe('runUninstall — prompt accepted', () => {
  it('returns "confirmed" and prints "would delete" for each path when user enters y', async () => {
    const promptTexts: string[] = []
    const { result, out } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: true,
        readLine: async () => 'y',
        writePrompt: (t) => promptTexts.push(t),
      }),
    )
    expect(result).toBe('confirmed')
    expect(out.some((l) => l.includes('would delete') && l.includes(fakePaths.binPath))).toBe(true)
    expect(out.some((l) => l.includes('would delete') && l.includes(fakePaths.srcDir))).toBe(true)
  })

  it('prompts "Delete these? [y/N]" on a TTY when --yes is not passed', async () => {
    const promptTexts: string[] = []
    await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: true,
        readLine: async () => 'y',
        writePrompt: (t) => promptTexts.push(t),
      }),
    )
    expect(promptTexts.join('')).toContain('Delete these? [y/N]')
  })

  it('capital Y is also accepted', async () => {
    const { result } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: true,
        readLine: async () => 'Y',
        writePrompt: () => {},
      }),
    )
    expect(result).toBe('confirmed')
  })
})

// ─── prompt rejected ──────────────────────────────────────────────────────────

describe('runUninstall — prompt rejected', () => {
  it('returns "aborted" when user enters n', async () => {
    const { result, out } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: true,
        readLine: async () => 'n',
        writePrompt: () => {},
      }),
    )
    expect(result).toBe('aborted')
    expect(out.every((l) => !l.includes('would delete'))).toBe(true)
  })

  it('returns "aborted" when user enters empty input', async () => {
    const { result } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: true,
        readLine: async () => '',
        writePrompt: () => {},
      }),
    )
    expect(result).toBe('aborted')
  })

  it('returns "aborted" for any non-y character (e.g. "q")', async () => {
    const { result } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: true,
        readLine: async () => 'q',
        writePrompt: () => {},
      }),
    )
    expect(result).toBe('aborted')
  })

  it('does not print "would delete" lines when aborted', async () => {
    const { out } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: true,
        readLine: async () => 'n',
        writePrompt: () => {},
      }),
    )
    expect(out.every((l) => !l.includes('would delete'))).toBe(true)
  })
})

// ─── --yes flag ───────────────────────────────────────────────────────────────

describe('runUninstall — --yes / -y flag', () => {
  it('skips the prompt and returns "confirmed" when yes=true', async () => {
    let readLineCalled = false
    const promptTexts: string[] = []
    const { result, out } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: true,
        isTty: true,
        readLine: async () => {
          readLineCalled = true
          return 'n'
        },
        writePrompt: (t) => promptTexts.push(t),
      }),
    )
    expect(result).toBe('confirmed')
    expect(readLineCalled).toBe(false)
    expect(promptTexts.length).toBe(0)
    expect(out.some((l) => l.includes('would delete') && l.includes(fakePaths.binPath))).toBe(true)
    expect(out.some((l) => l.includes('would delete') && l.includes(fakePaths.srcDir))).toBe(true)
  })

  it('yes=true also works when stdin is not a TTY (non-interactive script use)', async () => {
    const { result } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: true,
        isTty: false,
        readLine: async () => '',
        writePrompt: () => {},
      }),
    )
    expect(result).toBe('confirmed')
  })
})

// ─── non-TTY without --yes ────────────────────────────────────────────────────

describe('runUninstall — non-TTY stdin without --yes', () => {
  it('returns "non-tty-aborted" instead of hanging', async () => {
    let readLineCalled = false
    const { result } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: false,
        readLine: async () => {
          readLineCalled = true
          return 'y'
        },
        writePrompt: () => {},
      }),
    )
    expect(result).toBe('non-tty-aborted')
    expect(readLineCalled).toBe(false)
  })

  it('prints a clear message to stderr when non-TTY and no --yes', async () => {
    const { err } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: false,
        readLine: async () => '',
        writePrompt: () => {},
      }),
    )
    expect(err.some((l) => l.toLowerCase().includes('--yes') || l.toLowerCase().includes('-y'))).toBe(true)
  })

  it('does not print "would delete" lines when non-TTY aborted', async () => {
    const { out } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: false,
        readLine: async () => '',
        writePrompt: () => {},
      }),
    )
    expect(out.every((l) => !l.includes('would delete'))).toBe(true)
  })
})

// ─── paths are always displayed ───────────────────────────────────────────────

describe('runUninstall — paths display', () => {
  it('always shows both paths before prompting', async () => {
    const { out } = await capturing(() =>
      runUninstall({
        paths: fakePaths,
        yes: false,
        isTty: true,
        readLine: async () => 'n',
        writePrompt: () => {},
      }),
    )
    expect(out.some((l) => l.includes(fakePaths.binPath))).toBe(true)
    expect(out.some((l) => l.includes(fakePaths.srcDir))).toBe(true)
  })
})
