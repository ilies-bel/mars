import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  stopProcess,
  makeOsStopDeps,
  STOP_GRACE_PERIOD_MS,
  type StopDeps,
} from './ui-stop'
import { getPidFilePath, readPidEntry, stopUi, type UiPidEntry } from './ui'

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

let tmpRepo: string
let stateDir: string
let originalMarsRepo: string | undefined

beforeEach(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-ui-stop-test-'))
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

const pidFilePath = (): string => resolve(stateDir, 'ui.pid.json')

const writePidEntry = (entry: UiPidEntry): void =>
  writeFileSync(pidFilePath(), JSON.stringify(entry, null, 2))

const makeEntry = (pid: number, port = 7777): UiPidEntry => ({
  pid,
  port,
  host: '127.0.0.1',
  startedAt: new Date().toISOString(),
})

/** Controllable StopDeps for unit tests. */
const makeTestDeps = (overrides?: Partial<StopDeps>): StopDeps => ({
  isAlive: () => false,
  sendSignal: () => {},
  removePidFile: () => {},
  gracePeriodMs: 200,
  pollIntervalMs: 10,
  // Port-listener deps — default to "no listeners, port always free" so that
  // existing unit tests that don't exercise the port-kill path are unaffected.
  findPortListeners: () => [],
  killProcessGroup: () => {},
  isPortFree: async () => true,
  ...overrides,
})

// Sentinel so we can distinguish our test-abort from real errors.
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

// ---------------------------------------------------------------------------
// stopProcess — unit tests (injectable deps, no real OS processes)
// ---------------------------------------------------------------------------

describe('stopProcess', () => {
  it('returns not-running when entry is null', async () => {
    const result = await stopProcess(null, pidFilePath(), makeTestDeps())
    expect(result).toEqual({ kind: 'not-running' })
  })

  it('returns not-running when pid is dead', async () => {
    const entry = makeEntry(2_147_483_647)
    writePidEntry(entry)

    const removedPaths: string[] = []
    const deps = makeTestDeps({
      isAlive: () => false,
      removePidFile: (p) => removedPaths.push(p),
    })

    const result = await stopProcess(entry, pidFilePath(), deps)

    expect(result).toEqual({ kind: 'not-running' })
    expect(removedPaths).toContain(pidFilePath())
  })

  it('sends SIGTERM and returns stopped-with-port when process exits cleanly', async () => {
    const signals: NodeJS.Signals[] = []
    let alive = true

    const deps = makeTestDeps({
      isAlive: () => alive,
      sendSignal: (_pid, sig) => {
        signals.push(sig)
        if (sig === 'SIGTERM') alive = false // process exits immediately on SIGTERM
      },
      gracePeriodMs: 500,
    })

    const entry = makeEntry(12345, 8080)
    writePidEntry(entry)

    const result = await stopProcess(entry, pidFilePath(), deps)

    expect(result).toEqual({ kind: 'stopped', pid: 12345, port: 8080 })
    expect(signals).toContain('SIGTERM')
    expect(signals).not.toContain('SIGKILL')
  })

  it('does NOT send SIGKILL when process exits within the grace period', async () => {
    const signals: NodeJS.Signals[] = []
    let alive = true

    const deps = makeTestDeps({
      isAlive: () => alive,
      sendSignal: (_pid, sig) => {
        signals.push(sig)
        alive = false // any signal causes the process to die
      },
      gracePeriodMs: 500,
      pollIntervalMs: 20,
    })

    const entry = makeEntry(12345)
    writePidEntry(entry)

    await stopProcess(entry, pidFilePath(), deps)

    expect(signals).toEqual(['SIGTERM'])
  })

  it('sends SIGKILL after the grace period when process does not exit', async () => {
    const signals: NodeJS.Signals[] = []

    const deps = makeTestDeps({
      isAlive: () => true, // never exits
      sendSignal: (_pid, sig) => signals.push(sig),
      gracePeriodMs: 50,
      pollIntervalMs: 10,
    })

    const entry = makeEntry(12345)
    writePidEntry(entry)

    const result = await stopProcess(entry, pidFilePath(), deps)

    expect(signals[0]).toBe('SIGTERM')
    expect(signals).toContain('SIGKILL')
    expect(result.kind).toBe('stopped')
  })

  it('removes the pidfile after stopping', async () => {
    const removedPaths: string[] = []
    let alive = true

    const deps = makeTestDeps({
      isAlive: () => alive,
      sendSignal: () => {
        alive = false
      },
      removePidFile: (p) => removedPaths.push(p),
    })

    const entry = makeEntry(12345, 9000)
    writePidEntry(entry)

    await stopProcess(entry, pidFilePath(), deps)

    expect(removedPaths).toContain(pidFilePath())
  })

  it('STOP_GRACE_PERIOD_MS is the documented grace period (2 seconds)', () => {
    expect(STOP_GRACE_PERIOD_MS).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// stopProcess — integration tests with real spawned processes
// ---------------------------------------------------------------------------

describe('stopProcess — real process', () => {
  it('terminates a live process and removes the pidfile', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000_000)'],
      { stdio: 'ignore' },
    )

    const pid = child.pid!
    const entry = makeEntry(pid, 7890)
    writePidEntry(entry)

    const result = await stopProcess(entry, pidFilePath(), makeOsStopDeps())

    expect(result).toEqual({ kind: 'stopped', pid, port: 7890 })
    expect(existsSync(pidFilePath())).toBe(false)

    // Verify the OS process is really gone.
    const osStillAlive = makeOsStopDeps().isAlive(pid)
    expect(osStillAlive).toBe(false)
  }, 8000)

  it('sends SIGTERM first; SIGKILL only after grace period if needed', async () => {
    // Spawn a process that traps SIGTERM but exits on SIGKILL.
    // Write 'ready\n' to stdout so we know the handler is registered before
    // sending SIGTERM — avoids a startup race where SIGTERM arrives before
    // the on('SIGTERM') call executes.
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1_000_000)",
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    await new Promise<void>((resolve) => {
      child.stdout!.on('data', (data: Buffer) => {
        if (data.toString().includes('ready')) resolve()
      })
    })
    const pid = child.pid!
    const entry = makeEntry(pid, 7891)
    writePidEntry(entry)

    const signals: NodeJS.Signals[] = []
    const osBase = makeOsStopDeps()
    const deps: StopDeps = {
      ...osBase,
      sendSignal: (p, sig) => {
        signals.push(sig)
        osBase.sendSignal(p, sig)
      },
      gracePeriodMs: 300,
      pollIntervalMs: 20,
    }

    const result = await stopProcess(entry, pidFilePath(), deps)

    expect(signals[0]).toBe('SIGTERM')
    expect(signals).toContain('SIGKILL')
    expect(result.kind).toBe('stopped')
    expect(existsSync(pidFilePath())).toBe(false)
  }, 8000)

  it('does not send SIGKILL when the process exits cleanly on SIGTERM', async () => {
    // Spawn a process that exits immediately on SIGTERM.
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000_000)",
      ],
      { stdio: 'ignore' },
    )
    const pid = child.pid!
    const entry = makeEntry(pid, 7892)
    writePidEntry(entry)

    const signals: NodeJS.Signals[] = []
    const osBase = makeOsStopDeps()
    const deps: StopDeps = {
      ...osBase,
      sendSignal: (p, sig) => {
        signals.push(sig)
        osBase.sendSignal(p, sig)
      },
      gracePeriodMs: 2000,
      pollIntervalMs: 20,
    }

    await stopProcess(entry, pidFilePath(), deps)

    expect(signals).not.toContain('SIGKILL')
    expect(signals).toContain('SIGTERM')
  }, 8000)

  it('kills orphaned port listener when the recorded pid is already dead (orphaned-bun scenario)', async () => {
    // Use a high ephemeral port to avoid collisions with other services.
    const TEST_PORT = 17843

    // Spawn a TCP server on TEST_PORT — this simulates bun continuing to run
    // after its wrapper (mars-ui.mjs) was killed externally.
    const orphan = spawn(
      process.execPath,
      [
        '-e',
        [
          "const net = require('net');",
          `net.createServer().listen(${TEST_PORT}, '127.0.0.1', () => process.stdout.write('ready\\n'));`,
          'setInterval(() => {}, 1_000_000);',
        ].join(' '),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )

    // Wait until the server is actually listening.
    await new Promise<void>((res) => {
      orphan.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('ready')) res()
      })
    })

    const orphanPid = orphan.pid!

    // Write a pidfile with a DEAD pid (2^31-1) but the real port — this is
    // the state left behind after the wrapper is externally killed.
    const entry = makeEntry(2_147_483_647, TEST_PORT)
    writePidEntry(entry)

    // stopProcess must detect the orphaned listener via lsof and kill it.
    const result = await stopProcess(entry, pidFilePath(), makeOsStopDeps())

    // The orphaned server process must be gone.
    expect(makeOsStopDeps().isAlive(orphanPid)).toBe(false)

    // The port must be free.
    expect(await makeOsStopDeps().isPortFree(TEST_PORT)).toBe(true)

    // The pidfile must be cleaned up.
    expect(existsSync(pidFilePath())).toBe(false)

    // The result kind is 'stopped' (not 'not-running') because a listener was found.
    expect(result.kind).toBe('stopped')
  }, 15000)
})

// ---------------------------------------------------------------------------
// stopUi — CLI-level behaviour tests
// ---------------------------------------------------------------------------

describe('stopUi', () => {
  it('prints "no ui running" and exits 0 when no process is running', async () => {
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

  it('succeeds with exit 0 the second time too (idempotent)', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000_000)'],
      { stdio: 'ignore' },
    )
    const pid = child.pid!
    writePidEntry(makeEntry(pid, 7893))

    // First call: kills the process.
    await withMockedExit(() => stopUi(tmpRepo))

    // Second call: nothing running, should still exit 0.
    const lines: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))

    let result2: { exitCode: number }
    try {
      result2 = await withMockedExit(() => stopUi(tmpRepo))
    } finally {
      console.log = origLog
    }

    expect(result2!.exitCode).toBe(0)
    expect(lines).toContain('no ui running')
  }, 10000)

  it('confirmation message identifies the freed port', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000_000)'],
      { stdio: 'ignore' },
    )
    const pid = child.pid!
    writePidEntry(makeEntry(pid, 9876))

    const lines: string[] = []
    const origLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))

    try {
      await withMockedExit(() => stopUi(tmpRepo))
    } finally {
      console.log = origLog
    }

    const confirmLine = lines.find((l) => l.includes('stopped'))
    expect(confirmLine).toBeDefined()
    expect(confirmLine).toContain('port=9876')
  }, 10000)

  it('removes the pidfile after a successful stop', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000_000)'],
      { stdio: 'ignore' },
    )
    const pid = child.pid!
    writePidEntry(makeEntry(pid, 7894))

    await withMockedExit(() => stopUi(tmpRepo))

    expect(existsSync(pidFilePath())).toBe(false)
  }, 10000)

  it('removes a stale pid file when no process is running', async () => {
    writePidEntry(makeEntry(2_147_483_647, 7777))
    expect(existsSync(pidFilePath())).toBe(true)

    await withMockedExit(() => stopUi(tmpRepo))

    expect(existsSync(pidFilePath())).toBe(false)
  })
})
