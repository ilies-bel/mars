/**
 * Tests for isDaemonReachable — the HTTP-port-based daemon liveness probe.
 *
 * These tests exercise the observable contract: absent/malformed port file →
 * false; stale port (no listener) → false; live TCP listener → true.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:net'
import { isDaemonReachable } from './paths'

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
