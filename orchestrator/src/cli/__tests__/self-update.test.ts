/**
 * Behavioural tests for `mars self-update`.
 *
 * The command POSTs to the daemon's `/actions/self-update` route using the
 * port from `.mars/http.port`. These tests verify:
 *
 *   (a) happy path: 200 { ok: true, status: 'started' } → confirmation printed
 *   (b) daemon-error path: non-2xx → daemon's error message surfaced verbatim
 *       (in particular the DEV_INSTALL message that tells the user to run
 *       `git pull && npm install`)
 *   (c) port-file-absent path: daemon-not-running message printed, code 1
 *
 * `fetch` is stubbed globally (vi.stubGlobal). The http.port file is written
 * to a real temp-dir so the port-file read path is exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'

const FAKE_PORT = 19998

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-self-update-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const writeDaemonPort = (repoDir: string, port: number): void => {
  writeFileSync(join(repoDir, '.mars', 'http.port'), String(port))
}

const loadOpts = async (repoDir: string): Promise<InProcessOptions> => {
  vi.resetModules()
  process.env.MARS_REPO = repoDir
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../core/store/task-store')
  const contextModule = await import('../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repoDir),
    daemon: makeFakeDaemon(),
  }
}

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('mars self-update', () => {
  it('happy path: prints confirmation on 200 { ok: true, status: started }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: 'started' }),
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['self-update'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('Self-update started')
    expect(r.out.join('\n')).toContain('daemon is replacing its binary')
    expect(r.err).toHaveLength(0)
  })

  it('happy path: POSTs to /actions/self-update on the daemon port', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, status: 'started' }),
    })
    vi.stubGlobal('fetch', mockFetch)
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    await runCommandInProcess(['self-update'], opts)

    expect(mockFetch).toHaveBeenCalledWith(
      `http://127.0.0.1:${FAKE_PORT}/actions/self-update`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('daemon-error path: surfaces the daemon message verbatim (DEV_INSTALL)', async () => {
    const devInstallMsg =
      'Self-update is not available for dev installs. Run: git pull && npm install'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'DEV_INSTALL', message: devInstallMsg }),
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['self-update'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain(devInstallMsg)
    expect(r.out).toHaveLength(0)
  })

  it('daemon-error path: falls back to error field when message is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'tasks still in flight' }),
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['self-update'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('tasks still in flight')
  })

  it('daemon-error path: falls back to status code when body has no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['self-update'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('500')
  })

  it('no-daemon path: prints daemon-not-running message when http.port is absent', async () => {
    // No http.port file written — daemon is not running.
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['self-update'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.out).toHaveLength(0)
  })

  it('no-daemon path: prints daemon-not-running message when fetch throws (daemon crashed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['self-update'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.out).toHaveLength(0)
  })
})
