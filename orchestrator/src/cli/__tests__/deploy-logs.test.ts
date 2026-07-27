/**
 * Behavioural tests for `mars deploy logs <taskId>`.
 *
 * The command GETs the daemon's `/deployments/:taskId/logs` route using the
 * port from `.mars/http.port` and prints the response text to stdout. These
 * tests verify:
 *
 *   (a) happy path: 200 text/plain → logs printed to stdout, exit 0
 *   (b) 404 path  : no deployment → error to stderr, exit 1
 *   (c) no-daemon : http.port absent → daemon-not-running message, exit 1
 *   (d) fetch throws (daemon crashed) → daemon-not-running message, exit 1
 *   (e) missing taskId → usage to stderr, exit 2
 *
 * `fetch` is stubbed globally (vi.stubGlobal). The http.port file is written
 * to a real temp-dir so the port-file read path is exercised end-to-end.
 * The noop provider log string ("noop") is asserted in the happy-path test to
 * confirm the correct surface is reached.
 *
 * `deploy logs` never accesses deps.store, so PGlite is not initialised here.
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
import { resolveContext } from '../../core/context'
import type { DomainTaskStore } from '../../core/store/task-store'

const FAKE_PORT = 19996

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-deploy-logs-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const writeDaemonPort = (repoDir: string, port: number): void => {
  writeFileSync(join(repoDir, '.mars', 'http.port'), String(port))
}

/**
 * Build minimal InProcessOptions for `deploy logs`. The command only reads
 * `deps.ctx.stateDir` (for http.port) and calls global `fetch` — no store
 * access, no daemon messages, no PGlite needed.
 */
const makeOpts = (repoDir: string): InProcessOptions => ({
  store: null as unknown as DomainTaskStore,
  ctx: resolveContext(repoDir),
  daemon: makeFakeDaemon(),
})

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(repo, { recursive: true, force: true })
})

describe('mars deploy logs', () => {
  it('happy path: prints noop provider logs to stdout on 200', async () => {
    const noopLogs = '[noop] deployment noop-task-1 — no real logs (NoopProvider)'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => noopLogs,
    }))
    writeDaemonPort(repo, FAKE_PORT)

    const r = await runCommandInProcess(['deploy', 'logs', 'task-1'], makeOpts(repo))

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('noop')
    expect(r.err).toHaveLength(0)
  })

  it('happy path: GETs the correct daemon route', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'some logs',
    })
    vi.stubGlobal('fetch', mockFetch)
    writeDaemonPort(repo, FAKE_PORT)

    await runCommandInProcess(['deploy', 'logs', 'task-1'], makeOpts(repo))

    expect(mockFetch).toHaveBeenCalledWith(
      `http://127.0.0.1:${FAKE_PORT}/deployments/task-1/logs`,
    )
  })

  it('404 path: exits non-zero with error message when no deployment exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () =>
        JSON.stringify({ ok: false, error: 'no deployment found for task task-1' }),
    }))
    writeDaemonPort(repo, FAKE_PORT)

    const r = await runCommandInProcess(['deploy', 'logs', 'task-1'], makeOpts(repo))

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no deployment found')
    expect(r.out).toHaveLength(0)
  })

  it('no-daemon path: exits non-zero when http.port is absent', async () => {
    // No http.port file written — daemon is not running.
    const r = await runCommandInProcess(['deploy', 'logs', 'task-1'], makeOpts(repo))

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.out).toHaveLength(0)
  })

  it('no-daemon path: exits non-zero when fetch throws (daemon crashed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    writeDaemonPort(repo, FAKE_PORT)

    const r = await runCommandInProcess(['deploy', 'logs', 'task-1'], makeOpts(repo))

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.out).toHaveLength(0)
  })

  it('missing taskId: exits code 2 with usage hint', async () => {
    const r = await runCommandInProcess(['deploy', 'logs'], makeOpts(repo))

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage')
  })
})
