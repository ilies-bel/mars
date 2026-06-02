import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// Each test gets an isolated temp directory rooted at a fresh repo so that
// `daemonPaths()` / `isDaemonAlive()` sees clean, predictable file state.
const setupEnv = (): { stateDir: string } => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-alive-'))
  const stateDir = resolve(repo, '.mars')
  mkdirSync(stateDir, { recursive: true })
  return { stateDir }
}

describe('isDaemonAlive', () => {
  let stateDir: string
  let cleanup: () => void

  beforeEach(() => {
    const env = setupEnv()
    stateDir = env.stateDir
    // Point resolveContext() at our temp dir so daemonPaths() resolves there.
    process.env.MARS_REPO = resolve(stateDir, '..')
    vi.resetModules()
    cleanup = () => {
      delete process.env.MARS_REPO
      vi.resetModules()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  afterEach(() => cleanup())

  const load = async () => {
    const { isDaemonAlive } = (await import(
      '../paths'
    )) as typeof import('../paths')
    return { isDaemonAlive }
  }

  // ── Tracer bullet ─────────────────────────────────────────────────────────

  it('returns reason=no-pid when neither socket nor pid file exist', async () => {
    const { isDaemonAlive } = await load()
    const result = await isDaemonAlive()
    expect(result.alive).toBe(false)
    if (!result.alive) {
      expect(result.reason).toBe('no-pid')
    }
  })

  // ── Stale socket ──────────────────────────────────────────────────────────

  it('returns reason=connect-failed when socket file exists but is dead', async () => {
    const socketPath = resolve(stateDir, 'watch.sock')
    // Write a socket file that nothing is listening on.
    writeFileSync(socketPath, '')

    const { isDaemonAlive } = await load()
    const result = await isDaemonAlive()
    expect(result.alive).toBe(false)
    if (!result.alive) {
      expect(result.reason).toBe('connect-failed')
    }
  })

  it('cleans up stale socket and pid files on connect-failed', async () => {
    const { existsSync } = await import('node:fs')
    const socketPath = resolve(stateDir, 'watch.sock')
    const pidPath = resolve(stateDir, 'watch.pid')
    writeFileSync(socketPath, '')
    writeFileSync(pidPath, '99999')

    const { isDaemonAlive } = await load()
    await isDaemonAlive()

    expect(existsSync(socketPath)).toBe(false)
    expect(existsSync(pidPath)).toBe(false)
  })

  // ── Dead pid file without socket ──────────────────────────────────────────

  it('returns reason=dead-pid when pid file exists but process is gone', async () => {
    const pidPath = resolve(stateDir, 'watch.pid')
    // Use a PID that almost certainly does not exist.
    writeFileSync(pidPath, '2147483647')

    const { isDaemonAlive } = await load()
    const result = await isDaemonAlive()
    expect(result.alive).toBe(false)
    if (!result.alive) {
      expect(result.reason).toBe('dead-pid')
    }
  })

  it('cleans up stale pid file on dead-pid', async () => {
    const { existsSync } = await import('node:fs')
    const pidPath = resolve(stateDir, 'watch.pid')
    writeFileSync(pidPath, '2147483647')

    const { isDaemonAlive } = await load()
    await isDaemonAlive()

    expect(existsSync(pidPath)).toBe(false)
  })

  // ── Alive daemon (socket connectable) ─────────────────────────────────────

  it('returns alive=true when a server is actually listening on the socket', async () => {
    const socketPath = resolve(stateDir, 'watch.sock')
    const pidPath = resolve(stateDir, 'watch.pid')

    // Start a real Unix socket server to simulate a live daemon.
    const server = createServer()
    await new Promise<void>((res) => server.listen(socketPath, res))

    writeFileSync(pidPath, String(process.pid))

    try {
      const { isDaemonAlive } = await load()
      const result = await isDaemonAlive()
      expect(result.alive).toBe(true)
      if (result.alive) {
        expect(result.pid).toBe(process.pid)
      }
    } finally {
      await new Promise<void>((res) => server.close(() => res()))
    }
  })
})
