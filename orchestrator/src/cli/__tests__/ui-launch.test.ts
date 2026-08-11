/**
 * Tests for launchUi() — the detached-spawn path.
 *
 * These tests verify:
 *   1. The child is spawned with detached:true so it runs in its own process
 *      group and survives the parent shell's exit / SIGHUP.
 *   2. stdio uses piped stdout/stderr (not 'inherit') — child is disconnected
 *      from the parent tty, which prevents the kernel from delivering a SIGHUP
 *      when the tty hangs up.
 *   3. The starting banner is printed ONLY after the child emits "listening on"
 *      confirming a successful bind — not optimistically upfront.
 *   4. child.unref() is called so the parent's event loop exits promptly.
 *   5. The pid file is written with the spawned pid, port, and host.
 *   6. When the port is occupied, the command exits non-zero and emits no
 *      url= line on stdout.
 *
 * Cross-boundary verification (the spawned server actually surviving after the
 * parent shell closes) is covered by the manual verification steps documented
 * in task mars-b49b6e3e:
 *
 *   mars ui &
 *   sleep 8
 *   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7777/   # expect 200
 *   sleep 30
 *   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7777/   # expect 200
 *   mars ui stop
 *   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7777/   # expect 000
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'

// Hoist mock before any module that imports node:child_process.
// Vitest's transformer moves vi.mock() calls to the top of the module so
// all subsequent imports (including ../ui) see the mocked version.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

// Import AFTER the vi.mock declaration.
import { spawn } from 'node:child_process'
import { launchUi, readPidEntry } from '../ui'

const spawnMock = vi.mocked(spawn)

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal pipe-like stream that launchUi attaches listeners to.
 * setEncoding, resume, and destroy are no-ops; unref is not called in tests
 * because the child is mocked.
 */
class FakePipe extends EventEmitter {
  setEncoding(_encoding: string): this { return this }
  // resume() is called by launchUi to drain the stream and release backpressure.
  resume(): this { return this }
  // destroy() may be called if the implementation changes.
  destroy(): void { /* no-op */ }
}

/** Build a fake ChildProcess with the pipe streams launchUi requires. */
const makeFakeChild = (pid = 12345) => {
  const child = new EventEmitter() as ReturnType<typeof spawn>
  ;(child as unknown as { pid: number }).pid = pid
  ;(child as unknown as { unref: () => void }).unref = vi.fn()
  ;(child as unknown as { stdout: FakePipe }).stdout = new FakePipe()
  ;(child as unknown as { stderr: FakePipe }).stderr = new FakePipe()
  return child
}

type FakeChild = ReturnType<typeof makeFakeChild> & {
  stdout: FakePipe
  stderr: FakePipe
  unref: ReturnType<typeof vi.fn>
}

// ── fixtures ──────────────────────────────────────────────────────────────────

let tmpRepo: string
let stateDir: string
let originalMarsRepo: string | undefined

beforeEach(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-ui-launch-test-'))
  stateDir = resolve(tmpRepo, '.mars')
  mkdirSync(stateDir, { recursive: true })
  originalMarsRepo = process.env['MARS_REPO']
  process.env['MARS_REPO'] = tmpRepo
  spawnMock.mockReset()
})

afterEach(() => {
  if (originalMarsRepo === undefined) {
    delete process.env['MARS_REPO']
  } else {
    process.env['MARS_REPO'] = originalMarsRepo
  }
  rmSync(tmpRepo, { recursive: true, force: true })
  spawnMock.mockReset()
})

// ── helper: emit the "listening on" signal from a fake child ─────────────────

/** Signal successful bind from the fake child's stdout. */
const signalReady = (child: FakeChild, url = 'http://127.0.0.1:7777'): void => {
  ;(child as unknown as { stdout: FakePipe }).stdout.emit(
    'data',
    `mars-ui  repo=/tmp/repo\n         db=/tmp/db\n         listening on ${url}\n`,
  )
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('launchUi — detached spawn', () => {
  it('spawns with detached:true so the child outlives the parent shell', async () => {
    const fakeChild = makeFakeChild(12345)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo })
    signalReady(fakeChild as unknown as FakeChild)
    await promise

    expect(spawnMock).toHaveBeenCalledOnce()
    const [, , opts] = spawnMock.mock.calls[0]
    expect(opts).toMatchObject({ detached: true })
  })

  it('uses piped stdout/stderr — child is disconnected from the parent tty', async () => {
    const fakeChild = makeFakeChild(12345)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo })
    signalReady(fakeChild as unknown as FakeChild)
    await promise

    const [, , opts] = spawnMock.mock.calls[0]
    const stdio = opts?.stdio as string[]
    // stdin must be 'ignore' so no tty SIGHUP on hangup
    expect(stdio[0]).toBe('ignore')
    // stdout and stderr must be 'pipe' (not 'inherit') for readiness detection
    expect(stdio[1]).toBe('pipe')
    expect(stdio[2]).toBe('pipe')
  })

  it('calls child.unref() so the parent event loop exits without waiting', async () => {
    const fakeChild = makeFakeChild(12345)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo })
    signalReady(fakeChild as unknown as FakeChild)
    await promise

    const unref = (fakeChild as unknown as FakeChild).unref
    expect(unref).toHaveBeenCalled()
  })

  it('writes the pid file only after the child confirms a successful bind', async () => {
    const fakeChild = makeFakeChild(99999)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo })
    signalReady(fakeChild as unknown as FakeChild)
    await promise

    const entry = readPidEntry(tmpRepo)
    expect(entry).not.toBeNull()
    expect(entry!.pid).toBe(99999)
    expect(entry!.port).toBe(7777)
    expect(entry!.host).toBe('127.0.0.1')
    expect(entry!.startedAt).toBeTruthy()
  })

  it('prints the starting banner only after the child signals a successful bind', async () => {
    const fakeChild = makeFakeChild(42)
    spawnMock.mockReturnValue(fakeChild)

    const stdoutChunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      stdoutChunks.push(s)
      return true
    }

    try {
      const promise = launchUi({ repo: tmpRepo })

      // Banner must NOT appear before the ready signal
      expect(stdoutChunks.join('')).not.toContain('url=')

      signalReady(fakeChild as unknown as FakeChild)
      await promise
    } finally {
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = origWrite
    }

    const output = stdoutChunks.join('')
    expect(output).toContain('pid=42')
    expect(output).toContain('url=http://127.0.0.1:7777')
    expect(output).toContain('ui.log')
  })

  it('uses the provided port and host', async () => {
    const fakeChild = makeFakeChild(1234)
    spawnMock.mockReturnValue(fakeChild)

    const stdoutChunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      stdoutChunks.push(s)
      return true
    }

    try {
      const promise = launchUi({ repo: tmpRepo, port: '8888', host: '0.0.0.0' })
      signalReady(fakeChild as unknown as FakeChild, 'http://0.0.0.0:8888')
      await promise
    } finally {
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = origWrite
    }

    const entry = readPidEntry(tmpRepo)
    expect(entry!.port).toBe(8888)
    expect(entry!.host).toBe('0.0.0.0')
    expect(stdoutChunks.join('')).toContain('url=http://0.0.0.0:8888')
  })

  it('passes --port and --host args to the spawned launcher', async () => {
    const fakeChild = makeFakeChild(555)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo, port: '9000', host: '0.0.0.0' })
    signalReady(fakeChild as unknown as FakeChild, 'http://0.0.0.0:9000')
    await promise

    const [, launcherArgs] = spawnMock.mock.calls[0]
    const argStr = launcherArgs.join(' ')
    expect(argStr).toContain('--port 9000')
    expect(argStr).toContain('--host 0.0.0.0')
  })

  it('exits non-zero with the conflict message on stderr when the port is in use', async () => {
    const fakeChild = makeFakeChild(777)
    spawnMock.mockReturnValue(fakeChild)

    const stderrChunks: string[] = []
    const stdoutChunks: string[] = []
    const origStderrWrite = process.stderr.write.bind(process.stderr)
    const origStdoutWrite = process.stdout.write.bind(process.stdout)
    ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      stderrChunks.push(s)
      return true
    }
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      stdoutChunks.push(s)
      return true
    }

    const conflictMsg =
      'mars-ui: port 7777 is in use by mars-ui for a different project (/other/repo) — pass --port <n> to use another port'

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (_code?: string | number | null): never => {
        throw new Error(`process.exit(${_code})`)
      },
    )

    try {
      const promise = launchUi({ repo: tmpRepo })
      // Emit the conflict error then signal non-zero exit.
      ;(fakeChild as unknown as FakeChild).stderr.emit('data', conflictMsg)
      fakeChild.emit('exit', 1, null)
      await promise
    } catch (err) {
      expect((err as Error).message).toBe('process.exit(1)')
    } finally {
      ;(process.stderr as unknown as { write: (s: string) => boolean }).write = origStderrWrite
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = origStdoutWrite
      exitSpy.mockRestore()
    }

    // Conflict message must appear on stderr
    expect(stderrChunks.join('')).toContain('port 7777 is in use')
    expect(stderrChunks.join('')).toContain('/other/repo')
    // No url= line must appear on stdout
    expect(stdoutChunks.join('')).not.toContain('url=')
  })
})

// ── Vite-port and dev-mode behaviour ─────────────────────────────────────────

describe('launchUi — vite port and dev mode', () => {
  /**
   * Test 1 (port fallback, observable at launchUi level):
   * In dev mode mars-ui.mjs auto-selects the Vite port and reports it in the
   * "listening on" line. launchUi must record THAT port in the pid entry — not
   * a hard-coded 7777. Simulate both the happy path (5173) and the fallback path
   * (e.g. 5432 when 5173 was occupied on 127.0.0.1).
   *
   * The IPv4-only probe (ensuring an [::1]:5173 holder does NOT cause a shift) is
   * behaviour internal to mars-ui.mjs verified by the manual e2e steps in the task
   * brief — it cannot be exercised through the spawn mock at this level.
   */
  it('records the Vite port (not 7777) in the pid entry when dev child signals a non-default port', async () => {
    const fakeChild = makeFakeChild(11111)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo, dev: true })
    // Simulate mars-ui.mjs auto-selecting port 5432 (5173 was occupied on 127.0.0.1)
    signalReady(fakeChild as unknown as FakeChild, 'http://127.0.0.1:5432')
    await promise

    const entry = readPidEntry(tmpRepo)
    expect(entry!.port).toBe(5432)
    expect(entry!.host).toBe('127.0.0.1')
  })

  it('records the default Vite port (5173) when dev child signals the default port', async () => {
    const fakeChild = makeFakeChild(22222)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo, dev: true })
    signalReady(fakeChild as unknown as FakeChild, 'http://127.0.0.1:5173')
    await promise

    const entry = readPidEntry(tmpRepo)
    expect(entry!.port).toBe(5173)
  })

  /** Test 2: --vite-port is forwarded verbatim to the launched child. */
  it('forwards --vite-port to the launched child args', async () => {
    const fakeChild = makeFakeChild(33333)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo, vitePort: '5555' })
    signalReady(fakeChild as unknown as FakeChild)
    await promise

    const [, launcherArgs] = spawnMock.mock.calls[0]
    expect((launcherArgs as string[]).join(' ')).toContain('--vite-port 5555')
  })

  it('does not add --vite-port to child args when vitePort is not set', async () => {
    const fakeChild = makeFakeChild(44444)
    spawnMock.mockReturnValue(fakeChild)

    const promise = launchUi({ repo: tmpRepo })
    signalReady(fakeChild as unknown as FakeChild)
    await promise

    const [, launcherArgs] = spawnMock.mock.calls[0]
    expect((launcherArgs as string[]).join(' ')).not.toContain('--vite-port')
  })

  /** Test 3: In dev mode the banner URL shows the Vite port, not 7777. */
  it('prints the Vite port (not 7777) in the banner when in dev mode', async () => {
    const fakeChild = makeFakeChild(55555)
    spawnMock.mockReturnValue(fakeChild)

    const stdoutChunks: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      stdoutChunks.push(s)
      return true
    }

    try {
      const promise = launchUi({ repo: tmpRepo, dev: true })
      signalReady(fakeChild as unknown as FakeChild, 'http://127.0.0.1:5432')
      await promise
    } finally {
      ;(process.stdout as unknown as { write: (s: string) => boolean }).write = origWrite
    }

    const output = stdoutChunks.join('')
    expect(output).toContain('url=http://127.0.0.1:5432')
    expect(output).not.toContain('url=http://127.0.0.1:7777')
  })

  /**
   * Test 4: MARS_UI_API_BASE / VITE_API_BASE env discipline.
   *
   * launchUi passes process.env to the child unchanged — it does not inject
   * VITE_API_BASE. The child (mars-ui.mjs) is responsible for setting
   * MARS_UI_API_BASE in vite's env and omitting VITE_API_BASE; that behaviour is
   * verified by the manual e2e steps in the task brief.
   *
   * What we CAN verify here: launchUi never adds VITE_API_BASE to the child env,
   * even if MARS_UI_API_BASE was requested (e.g. by the user for a second project
   * talking to a remote API — that is an intentional manual escape hatch, not a
   * mars-ui launch concern).
   */
  it('does not inject VITE_API_BASE into the child env', async () => {
    const savedVal = process.env['VITE_API_BASE']
    delete process.env['VITE_API_BASE']

    try {
      const fakeChild = makeFakeChild(66666)
      spawnMock.mockReturnValue(fakeChild)

      const promise = launchUi({ repo: tmpRepo })
      signalReady(fakeChild as unknown as FakeChild)
      await promise

      const [, , spawnOpts] = spawnMock.mock.calls[0] as [unknown, unknown, { env?: Record<string, string> }]
      expect(spawnOpts.env?.['VITE_API_BASE']).toBeUndefined()
    } finally {
      if (savedVal !== undefined) process.env['VITE_API_BASE'] = savedVal
    }
  })
})
