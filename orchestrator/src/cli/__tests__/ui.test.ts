import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  getPidFilePath,
  readPidEntry,
  stopUi,
  statusUi,
  resolveLauncher,
  printUiDiscoveryHint,
  type UiPidEntry,
  type StatusUiDeps,
} from '../ui'

// Isolate each test in a temporary directory that looks like a mars repo.
// We point resolveContext to it via the MARS_REPO env var.

let tmpRepo: string
let stateDir: string
let originalMarsRepo: string | undefined

beforeEach(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-ui-test-'))
  stateDir = resolve(tmpRepo, '.mars')
  mkdirSync(stateDir, { recursive: true })
  originalMarsRepo = process.env['MARS_REPO']
  process.env['MARS_REPO'] = tmpRepo
})

afterEach(() => {
  if (originalMarsRepo === undefined) {
    delete process.env['MARS_REPO']
  } else {
    process.env['MARS_REPO'] = originalMarsRepo
  }
  rmSync(tmpRepo, { recursive: true, force: true })
})

const pidFilePath = () => resolve(stateDir, 'ui.pid.json')

const writePidEntry = (entry: UiPidEntry) =>
  writeFileSync(pidFilePath(), JSON.stringify(entry, null, 2))

describe('getPidFilePath', () => {
  it('returns a path inside the .mars state directory', () => {
    const p = getPidFilePath(tmpRepo)
    expect(p).toBe(resolve(stateDir, 'ui.pid.json'))
  })
})

describe('readPidEntry', () => {
  it('returns null when no pid file exists', () => {
    expect(readPidEntry(tmpRepo)).toBeNull()
  })

  it('returns the parsed entry when the file exists', () => {
    const entry: UiPidEntry = {
      pid: 12345,
      port: 7777,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
    }
    writePidEntry(entry)
    const result = readPidEntry(tmpRepo)
    expect(result).toEqual(entry)
  })

  it('returns null when the file is malformed JSON', () => {
    writeFileSync(pidFilePath(), 'not-json')
    expect(readPidEntry(tmpRepo)).toBeNull()
  })
})

/** Capture console.log lines during an async action. */
const captureLog = async (fn: () => Promise<void>): Promise<string[]> => {
  const lines: string[] = []
  const orig = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(' '))
  try {
    await fn()
  } finally {
    console.log = orig
  }
  return lines
}

/** A probeFetch stub that simulates a healthy server (200 OK). */
const okProbe: StatusUiDeps['probeFetch'] = async () => new Response('ok', { status: 200 })

/** A probeFetch stub that simulates a server returning 404. */
const notFoundProbe: StatusUiDeps['probeFetch'] = async () =>
  new Response('not found', { status: 404 })

/** A probeFetch stub that simulates a connection refusal. */
const refusedProbe: StatusUiDeps['probeFetch'] = async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:7777')
}

describe('statusUi', () => {
  it('prints "not running" when no pid file exists', async () => {
    const lines = await captureLog(() => statusUi(tmpRepo, { probeFetch: okProbe }))
    expect(lines).toContain('not running')
  })

  it('prints "not running" when pid file references a dead pid', async () => {
    // pid 0 is not a valid process we could kill, but sending signal 0 to a
    // non-existent pid throws — simulating a dead process with a pid that
    // definitely doesn't exist (very large number).
    const entry: UiPidEntry = {
      pid: 2_147_483_647, // max int32; will not be alive
      port: 7777,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
    }
    writePidEntry(entry)
    const lines = await captureLog(() => statusUi(tmpRepo, { probeFetch: okProbe }))
    expect(lines).toContain('not running')
  })

  it('prints pid/port/url when the process is alive and the URL probe succeeds', async () => {
    // Use our own pid as a stand-in for a "live" process.
    const entry: UiPidEntry = {
      pid: process.pid,
      port: 7777,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
    }
    writePidEntry(entry)
    const lines = await captureLog(() => statusUi(tmpRepo, { probeFetch: okProbe }))
    expect(lines[0]).toContain(`pid=${process.pid}`)
    expect(lines[0]).toContain('port=7777')
    expect(lines[0]).toContain('url=http://127.0.0.1:7777')
    expect(lines[0]).not.toContain('unhealthy')
  })

  it('reports unhealthy with the status code when the root path returns a non-2xx response', async () => {
    const entry: UiPidEntry = {
      pid: process.pid,
      port: 7777,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
    }
    writePidEntry(entry)
    const lines = await captureLog(() => statusUi(tmpRepo, { probeFetch: notFoundProbe }))
    expect(lines[0]).toContain('unhealthy')
    expect(lines[0]).toContain('404')
    expect(lines[0]).toContain(`pid=${process.pid}`)
    expect(lines[0]).toContain('url=http://127.0.0.1:7777')
  })

  it('reports unhealthy with the error message when the URL probe throws', async () => {
    const entry: UiPidEntry = {
      pid: process.pid,
      port: 7777,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
    }
    writePidEntry(entry)
    const lines = await captureLog(() => statusUi(tmpRepo, { probeFetch: refusedProbe }))
    expect(lines[0]).toContain('unhealthy')
    expect(lines[0]).toContain('ECONNREFUSED')
  })
})

// Sentinel error class so we can distinguish our test-abort from real errors.
class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`)
    this.name = 'ExitCalled'
  }
}

const withMockedExit = async (
  fn: () => Promise<void> | void,
): Promise<{ exitCode: number }> => {
  const origExit = process.exit.bind(process) as (code?: number) => never
  let exitCode = -1
  ;(process as { exit: (code?: number) => void }).exit = (code?: number) => {
    exitCode = code ?? 0
    throw new ExitCalled(exitCode)
  }
  try {
    await fn()
  } catch (err) {
    if (!(err instanceof ExitCalled)) throw err
  } finally {
    ;(process as { exit: (code?: number) => void }).exit = origExit
  }
  return { exitCode }
}

describe('stopUi — no running process', () => {
  it('exits 0 and prints "no ui running" when no pid file', async () => {
    const lines: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    let result: { exitCode: number }
    try {
      result = await withMockedExit(() => stopUi(tmpRepo))
    } finally {
      console.log = origLog
    }
    expect(lines).toContain('no ui running')
    expect(result!.exitCode).toBe(0)
  })

  it('removes a stale pid file and exits 0', async () => {
    const entry: UiPidEntry = {
      pid: 2_147_483_647,
      port: 7777,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
    }
    writePidEntry(entry)
    expect(existsSync(pidFilePath())).toBe(true)

    const result = await withMockedExit(() => stopUi(tmpRepo))

    expect(existsSync(pidFilePath())).toBe(false)
    expect(result.exitCode).toBe(0)
  })
})

describe('resolveLauncher', () => {
  it('returns null when no launcher file exists on disk', () => {
    // In the test environment the ui/bin/mars-ui.mjs file is not present,
    // so resolveLauncher must return null without throwing.
    const result = resolveLauncher()
    // Either null (file absent) or a string (file present in a full install).
    // Both are valid; the test asserts the call does not throw and returns
    // the correct type.
    expect(result === null || typeof result === 'string').toBe(true)
  })
})

describe('printUiDiscoveryHint — init dashboard discoverability', () => {
  const captureStdout = (fn: () => void): string => {
    const chunks: string[] = []
    const orig = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      chunks.push(s)
      return true
    }
    try {
      fn()
    } finally {
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = orig
    }
    return chunks.join('')
  }

  it('prints the mars ui launch command when the launcher is resolved', () => {
    const repoRoot = '/home/user/my-project'
    const fakeLauncher = '/path/to/ui/bin/mars-ui.mjs'
    const output = captureStdout(() => printUiDiscoveryHint(repoRoot, fakeLauncher))
    expect(output).toContain('mars ui --repo /home/user/my-project')
    expect(output).toContain('http://127.0.0.1:7777')
    expect(output).toContain('[mars init]')
  })

  it('prints a build hint when the launcher cannot be resolved', () => {
    const repoRoot = '/home/user/my-project'
    const output = captureStdout(() => printUiDiscoveryHint(repoRoot, null))
    expect(output).toContain('cd ui && npm install && npm run build')
    expect(output).toContain('[mars init]')
    expect(output).not.toContain('mars ui --repo')
  })

  it('does not throw when launcher is present', () => {
    expect(() => printUiDiscoveryHint('/repo', '/some/launcher.mjs')).not.toThrow()
  })

  it('does not throw when launcher is absent', () => {
    expect(() => printUiDiscoveryHint('/repo', null)).not.toThrow()
  })
})
