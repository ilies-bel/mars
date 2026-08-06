/**
 * Behavioural tests for `mars alert list` error messages.
 *
 * The command must distinguish between three failure modes:
 *   (a) port file absent → "daemon not running" (include daemon start hint)
 *   (b) port file present, fetch times out → "did not answer within 2s" (do
 *       NOT say "not running"; the daemon may be draining)
 *   (c) port file present, connection refused → "daemon not running"
 *
 * `fetch` is stubbed globally (vi.stubGlobal). The http.port file is written
 * to a real temp dir so the port-file read path is exercised end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCommandInProcess, makeFakeDaemon, type InProcessOptions } from '../../test-adapter'
import type { OrchestratorContext } from '../../../core/context'

const FAKE_PORT = 29998

let stateDir: string

const makeCtx = (dir: string): OrchestratorContext => ({
  repoRoot: dir,
  stateDir: join(dir, '.mars'),
  queueDbPath: join(dir, '.mars', 'queue.db'),
  observabilityDbPath: join(dir, '.mars', 'obs.db'),
  stateDbPath: join(dir, '.mars', 'state.db'),
})

const writeDaemonPort = (dir: string, port: number): void => {
  writeFileSync(join(dir, '.mars', 'http.port'), String(port))
}

const makeOpts = (dir: string): InProcessOptions => ({
  store: {} as never,
  daemon: makeFakeDaemon(),
  ctx: makeCtx(dir),
})

beforeEach(() => {
  stateDir = mkdtempSync(resolve(tmpdir(), 'mars-alert-list-test-'))
  mkdirSync(join(stateDir, '.mars'), { recursive: true })
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    rmSync(stateDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe('alert list — error messages', () => {
  it('reports daemon not running when the port file is absent', async () => {
    // No http.port written.
    const r = await runCommandInProcess(['alert', 'list'], makeOpts(stateDir))

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.err.join('\n')).toContain('mars daemon start')
    expect(r.out).toHaveLength(0)
  })

  it('reports daemon not running on ECONNREFUSED (daemon fully stopped)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:29998'), { code: 'ECONNREFUSED' }),
    ))
    writeDaemonPort(stateDir, FAKE_PORT)

    const r = await runCommandInProcess(['alert', 'list'], makeOpts(stateDir))

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.out).toHaveLength(0)
  })

  it('reports daemon did not answer on timeout (draining or busy) — NOT "not running"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
    ))
    writeDaemonPort(stateDir, FAKE_PORT)

    const r = await runCommandInProcess(['alert', 'list'], makeOpts(stateDir))

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon did not answer within 2s')
    expect(r.err.join('\n')).not.toContain('daemon not running')
    expect(r.err.join('\n')).not.toContain('mars daemon start')
    expect(r.out).toHaveLength(0)
  })

  it('reports daemon did not answer on AbortError (fetch timed out via signal)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    ))
    writeDaemonPort(stateDir, FAKE_PORT)

    const r = await runCommandInProcess(['alert', 'list'], makeOpts(stateDir))

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon did not answer within 2s')
    expect(r.err.join('\n')).not.toContain('daemon not running')
    expect(r.out).toHaveLength(0)
  })

  it('reports HTTP failure from the daemon (non-2xx response)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))
    writeDaemonPort(stateDir, FAKE_PORT)

    const r = await runCommandInProcess(['alert', 'list'], makeOpts(stateDir))

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon returned 503')
    // A 503 from a running daemon is NOT "not running"
    expect(r.err.join('\n')).not.toContain('daemon not running')
    expect(r.out).toHaveLength(0)
  })

  it('returns no alerts when the daemon responds with an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    }))
    writeDaemonPort(stateDir, FAKE_PORT)

    const r = await runCommandInProcess(['alert', 'list'], makeOpts(stateDir))

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('no alerts')
    expect(r.err).toHaveLength(0)
  })
})
