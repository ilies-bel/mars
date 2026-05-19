import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { getPidFilePath, readPidEntry, stopUi, statusUi, type UiPidEntry } from '../ui'

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

describe('statusUi', () => {
  it('prints "not running" when no pid file exists', () => {
    const lines: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    try {
      statusUi(tmpRepo)
    } finally {
      console.log = orig
    }
    expect(lines).toContain('not running')
  })

  it('prints "not running" when pid file references a dead pid', () => {
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

    const lines: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    try {
      statusUi(tmpRepo)
    } finally {
      console.log = orig
    }
    expect(lines).toContain('not running')
  })

  it('prints pid/port/url when the process is alive', () => {
    // Use our own pid as a stand-in for a "live" process.
    const entry: UiPidEntry = {
      pid: process.pid,
      port: 7777,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
    }
    writePidEntry(entry)

    const lines: string[] = []
    const orig = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    try {
      statusUi(tmpRepo)
    } finally {
      console.log = orig
    }
    expect(lines[0]).toContain(`pid=${process.pid}`)
    expect(lines[0]).toContain('port=7777')
    expect(lines[0]).toContain('url=http://127.0.0.1:7777')
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
