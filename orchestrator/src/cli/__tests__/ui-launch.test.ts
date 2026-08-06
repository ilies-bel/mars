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
