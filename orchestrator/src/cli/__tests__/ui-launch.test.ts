/**
 * Tests for launchUi() — the detached-spawn path.
 *
 * These tests verify:
 *   1. The child is spawned with detached:true so it runs in its own process
 *      group and survives the parent shell's exit / SIGHUP.
 *   2. stdio is NOT 'inherit' — the child is disconnected from the parent tty,
 *      which prevents the kernel from delivering a SIGHUP when the tty hangs up.
 *   3. child.unref() is called so the parent's event loop exits promptly.
 *   4. The pid file is written with the spawned pid, port, and host.
 *   5. A human-readable starting message is printed to stdout.
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

/** Build a fake ChildProcess with the bare minimum surface used by launchUi. */
const makeFakeChild = (pid = 12345) => {
  const child = new EventEmitter() as ReturnType<typeof spawn>
  // Cast is safe — we only need pid and unref in launchUi.
  ;(child as unknown as { pid: number }).pid = pid
  ;(child as unknown as { unref: () => void }).unref = vi.fn()
  return child
}

/** Capture everything written to process.stdout during fn(). */
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

// ── tests ─────────────────────────────────────────────────────────────────────

describe('launchUi — detached spawn', () => {
  it('spawns with detached:true so the child outlives the parent shell', () => {
    const fakeChild = makeFakeChild(12345)
    spawnMock.mockReturnValue(fakeChild)

    captureStdout(() => launchUi({ repo: tmpRepo }))

    expect(spawnMock).toHaveBeenCalledOnce()
    const [, , opts] = spawnMock.mock.calls[0]
    expect(opts).toMatchObject({ detached: true })
  })

  it('does not use "inherit" stdio — child is disconnected from the tty', () => {
    const fakeChild = makeFakeChild(12345)
    spawnMock.mockReturnValue(fakeChild)

    captureStdout(() => launchUi({ repo: tmpRepo }))

    const [, , opts] = spawnMock.mock.calls[0]
    const stdio = opts?.stdio as string[]
    // stdin must be 'ignore' so no tty SIGHUP on hangup
    expect(stdio[0]).toBe('ignore')
    // stdout and stderr must be fds (numbers), not 'inherit'
    expect(typeof stdio[1]).toBe('number')
    expect(typeof stdio[2]).toBe('number')
  })

  it('calls child.unref() so the parent event loop exits without waiting', () => {
    const fakeChild = makeFakeChild(12345)
    spawnMock.mockReturnValue(fakeChild)

    captureStdout(() => launchUi({ repo: tmpRepo }))

    const unref = (fakeChild as unknown as { unref: ReturnType<typeof vi.fn> }).unref
    expect(unref).toHaveBeenCalled()
  })

  it('writes a pid file with the spawned pid immediately', () => {
    const fakeChild = makeFakeChild(99999)
    spawnMock.mockReturnValue(fakeChild)

    captureStdout(() => launchUi({ repo: tmpRepo }))

    const entry = readPidEntry(tmpRepo)
    expect(entry).not.toBeNull()
    expect(entry!.pid).toBe(99999)
    expect(entry!.port).toBe(7777)
    expect(entry!.host).toBe('127.0.0.1')
    expect(entry!.startedAt).toBeTruthy()
  })

  it('prints a starting message with pid, url, and log path', () => {
    const fakeChild = makeFakeChild(42)
    spawnMock.mockReturnValue(fakeChild)

    const output = captureStdout(() => launchUi({ repo: tmpRepo }))

    expect(output).toContain('pid=42')
    expect(output).toContain('url=http://127.0.0.1:7777')
    expect(output).toContain('ui.log')
  })

  it('uses the provided port and host', () => {
    const fakeChild = makeFakeChild(1234)
    spawnMock.mockReturnValue(fakeChild)

    const output = captureStdout(() =>
      launchUi({ repo: tmpRepo, port: '8888', host: '0.0.0.0' }),
    )

    const entry = readPidEntry(tmpRepo)
    expect(entry!.port).toBe(8888)
    expect(entry!.host).toBe('0.0.0.0')
    expect(output).toContain('url=http://0.0.0.0:8888')
  })

  it('passes --port and --host args to the spawned launcher', () => {
    const fakeChild = makeFakeChild(555)
    spawnMock.mockReturnValue(fakeChild)

    captureStdout(() => launchUi({ repo: tmpRepo, port: '9000', host: '0.0.0.0' }))

    const [, launcherArgs] = spawnMock.mock.calls[0]
    const argStr = launcherArgs.join(' ')
    expect(argStr).toContain('--port 9000')
    expect(argStr).toContain('--host 0.0.0.0')
  })
})
