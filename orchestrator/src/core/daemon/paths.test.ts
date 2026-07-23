/**
 * Tests for isDaemonReachable — the HTTP-port-based daemon liveness probe.
 * Tests for waitForProcessExit — the bounded process-exit poller.
 * Tests for daemonPaths — lockFile field contract.
 * Tests for isProcessAlive — edge-case pid inputs.
 *
 * These tests exercise the observable contracts:
 *   isDaemonReachable: absent/malformed port file → false; stale port (no
 *     listener) → false; live TCP listener → true.
 *   waitForProcessExit: dead pid → true immediately; process exits within
 *     timeout → true; process still alive at deadline → false.
 *   daemonPaths: returns lockFile property (split-brain guard contract).
 *   isProcessAlive: invalid pid inputs → false; live pid → true.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:net'
import { daemonPaths, isDaemonReachable, isProcessAlive, waitForProcessExit } from './paths'

let stateDir: string

const setupStateDir = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-paths-test-'))
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

beforeEach(() => {
  stateDir = setupStateDir()
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('isDaemonReachable — absent / malformed port file', () => {
  it('returns false when http.port file is absent', async () => {
    // stateDir has no http.port file
    const result = await isDaemonReachable(stateDir)
    expect(result).toBe(false)
  })

  it('returns false when http.port contains non-numeric content', async () => {
    writeFileSync(resolve(stateDir, 'http.port'), 'not-a-number')
    const result = await isDaemonReachable(stateDir)
    expect(result).toBe(false)
  })

  it('returns false when http.port contains zero', async () => {
    writeFileSync(resolve(stateDir, 'http.port'), '0')
    const result = await isDaemonReachable(stateDir)
    expect(result).toBe(false)
  })

  it('returns false when http.port contains a negative number', async () => {
    writeFileSync(resolve(stateDir, 'http.port'), '-1')
    const result = await isDaemonReachable(stateDir)
    expect(result).toBe(false)
  })

  it('returns false when http.port contains a port above 65535', async () => {
    writeFileSync(resolve(stateDir, 'http.port'), '99999')
    const result = await isDaemonReachable(stateDir)
    expect(result).toBe(false)
  })

  it('returns false when http.port is empty', async () => {
    writeFileSync(resolve(stateDir, 'http.port'), '')
    const result = await isDaemonReachable(stateDir)
    expect(result).toBe(false)
  })
})

describe('isDaemonReachable — TCP connection probe', () => {
  it('returns false when port file is valid but no listener (stale port file)', async () => {
    // Port 1 is a well-known port that almost certainly has no listener in test
    // environments; connection to it will be refused immediately.
    writeFileSync(resolve(stateDir, 'http.port'), '1')
    const result = await isDaemonReachable(stateDir)
    expect(result).toBe(false)
  })

  it('returns true when a real TCP listener is bound at the recorded port', async () => {
    // Start a real server so the TCP probe can actually connect.
    const server: Server = await new Promise((onListen) => {
      const s = createServer()
      s.listen(0, '127.0.0.1', () => onListen(s))
    })
    const port = (server.address() as { port: number }).port
    writeFileSync(resolve(stateDir, 'http.port'), String(port))

    try {
      const result = await isDaemonReachable(stateDir)
      expect(result).toBe(true)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
})

describe('waitForProcessExit', () => {
  // ── Tracer bullet: already-dead pid ──────────────────────────────────────

  it('returns true immediately for a pid that is already dead', async () => {
    // Use a pid that is virtually guaranteed not to exist.
    const result = await waitForProcessExit(2147483647, 1_000)
    expect(result).toBe(true)
  })

  // ── Process exits within timeout ─────────────────────────────────────────

  it('returns true when the process exits before the deadline', async () => {
    // Start a real child process and kill it; waitForProcessExit should detect exit.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    const pid = child.pid!

    // Signal the child to exit.
    process.kill(pid, 'SIGTERM')

    const result = await waitForProcessExit(pid, 5_000)
    expect(result).toBe(true)
  })

  // ── Process still alive at deadline ──────────────────────────────────────

  it('returns false when the process is still alive at the deadline', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    const pid = child.pid!

    try {
      // Very short timeout — child is still running
      const result = await waitForProcessExit(pid, 50)
      expect(result).toBe(false)
    } finally {
      // Clean up: kill the child so it doesn't linger
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  })
})

// ── daemonPaths: lockFile contract ───────────────────────────────────────────
//
// The split-brain guard depends on `daemonPaths()` returning a `lockFile`
// path. Pin this as a contract test so a refactor cannot accidentally drop
// the field or change the file name.

describe('daemonPaths — lockFile contract', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-paths-lock-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns a lockFile path inside the .mars state directory', () => {
    const paths = daemonPaths()
    expect(paths.lockFile).toBeTruthy()
    expect(paths.lockFile).toMatch(/daemon\.lock$/)
    // Must be inside the repo's .mars state dir.
    expect(paths.lockFile.startsWith(resolve(repo, '.mars'))).toBe(true)
  })

  it('lockFile path does not exist initially (clean state)', () => {
    const paths = daemonPaths()
    expect(existsSync(paths.lockFile)).toBe(false)
  })

  it('lockFile is distinct from pidFile and socket paths', () => {
    const paths = daemonPaths()
    // All three paths must be different so a write to one cannot clobber the other.
    expect(paths.lockFile).not.toBe(paths.pidFile)
    expect(paths.lockFile).not.toBe(paths.socket)
  })
})

// ── isProcessAlive: edge-case inputs ─────────────────────────────────────────

describe('isProcessAlive — edge-case pid inputs', () => {
  it('returns false for pid 0', () => {
    expect(isProcessAlive(0)).toBe(false)
  })

  it('returns false for a negative pid', () => {
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('returns false for a non-integer pid', () => {
    expect(isProcessAlive(1.5)).toBe(false)
  })

  it('returns false for a virtually-impossible-to-exist pid', () => {
    // pid 2147483647 (INT_MAX) is virtually certain not to be a live process.
    expect(isProcessAlive(2147483647)).toBe(false)
  })

  it('returns true for the current process pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })
})
