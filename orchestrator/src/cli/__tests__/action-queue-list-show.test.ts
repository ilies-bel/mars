/**
 * Behavioural tests for `mars action-queue list` and `mars action-queue show`.
 *
 * Both commands read through the daemon's `GET /view/action-queue` endpoint
 * (the single source of truth shared with the UI). These tests verify:
 *
 *   (a) list formats rows from the daemon view correctly (tab-separated),
 *   (b) list --lean formats in summary mode,
 *   (c) list fails fast with a clear error when the daemon is not running,
 *   (d) show finds a row by exact id, entity id, or prefix,
 *   (e) show prints the id/kind/entity/priority/dismissed/at/dag header,
 *   (f) show fails fast when the daemon is not running.
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
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

const FAKE_PORT = 19999

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-aq-list-show-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/** Write the http.port file so the command can reach the fake daemon. */
const writeDaemonPort = (repoDir: string, port: number): void => {
  writeFileSync(join(repoDir, '.mars', 'http.port'), String(port))
}

/** Build minimal InProcessOptions backed by a real DB. */
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

/** Build a minimal ActionQueueRow for testing. */
const makeRow = (
  overrides: Partial<ActionQueueRow> & Pick<ActionQueueRow, 'id'>,
): ActionQueueRow => ({
  kind: 'failed-task',
  entityId: `entity-${overrides.id}`,
  priority: 'normal',
  title: `Title for ${overrides.id}`,
  body: `Body for ${overrides.id}`,
  at: '2026-01-01T00:00:00.000Z',
  dag: null,
  dismissed: false,
  ackState: null,
  errorKind: 'unknown',
  actions: [],
  staleWorktreeDetail: null,
  diagnosis: null,
  failureReasonCode: null,
  ...overrides,
})

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('action-queue list', () => {
  it('fetches from daemon and formats rows tab-separated', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-abc', priority: 'high', kind: 'failed-task', title: 'Task A', dismissed: false }),
      makeRow({ id: 'aq-def', priority: 'low', kind: 'draft-proposal', title: 'Prop B', dismissed: false }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(0)
    expect(r.out).toContain('aq-abc\topen\thigh\tfailed-task\tTask A')
    expect(r.out).toContain('aq-def\topen\tlow\tdraft-proposal\tProp B')
  })

  it('marks dismissed rows with dismissed flag', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-xyz', dismissed: true }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'dismissed'], opts)

    expect(r.code).toBe(0)
    expect(r.out[0]).toContain('\tdismissed\t')
  })

  it('passes the filter query param to the daemon', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    await runCommandInProcess(['action-queue', 'list', 'dismissed'], opts)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('filter=dismissed'),
    )
  })

  it('passes filter=all when asked', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    await runCommandInProcess(['action-queue', 'list', 'all'], opts)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('filter=all'),
    )
  })

  it('outputs "action queue empty" when daemon returns empty array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('action queue empty')
  })

  it('rejects an unknown filter with code 1', async () => {
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'bogus'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars action-queue list')
  })

  it('fails with daemon-not-running message when http.port is absent', async () => {
    // No http.port file written.
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.err.join('\n')).toContain('mars daemon start')
    expect(r.out).toHaveLength(0)
  })

  it('fails with daemon-not-running message when fetch throws (daemon crashed)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.out).toHaveLength(0)
  })

  it('--lean prints summary line and first 3 rows', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-1', kind: 'failed-task', title: 'T1' }),
      makeRow({ id: 'aq-2', kind: 'failed-task', title: 'T2' }),
      makeRow({ id: 'aq-3', kind: 'stale-worktree', title: 'T3' }),
      makeRow({ id: 'aq-4', kind: 'failed-task', title: 'T4' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open', '--lean'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    expect(combined).toContain('action queue 4')
    expect(combined).toContain('failed-task:3')
    expect(combined).toContain('stale-worktree:1')
    expect(combined).toContain('... +1 more')
    // First 3 rows should appear, 4th should not be listed individually
    expect(combined).toContain('aq-1')
    expect(combined).toContain('aq-2')
    expect(combined).toContain('aq-3')
    expect(combined).not.toContain('aq-4  ')
  })
})

// ---------------------------------------------------------------------------
// bare action-queue (alias for list open)
// ---------------------------------------------------------------------------

describe('bare action-queue', () => {
  it('delegates to list open', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue'], opts)

    expect(r.code).toBe(0)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('filter=open'),
    )
  })
})

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

describe('action-queue show', () => {
  it('prints the full header and body for an exact id match', async () => {
    const dag = {
      blockers: [],
      blocking: [{ id: 'mars-xyz', status: 'queued', summary: 'next' }],
      descendants: [],
      proposalId: null,
    }
    const rows: ActionQueueRow[] = [
      makeRow({
        id: 'aq-show-001',
        entityId: 'mars-task-001',
        kind: 'failed-task',
        priority: 'high',
        title: 'Show me',
        body: 'Detailed body text',
        at: '2026-03-01T12:00:00.000Z',
        dismissed: false,
        dag,
      }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-show-001'], opts)

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('id:        aq-show-001')
    expect(out).toContain('title:     Show me')
    expect(out).toContain('kind:      failed-task')
    expect(out).toContain('entity:    mars-task-001')
    expect(out).toContain('priority:  high')
    expect(out).toContain('dismissed: false')
    expect(out).toContain('at:        2026-03-01T12:00:00.000Z')
    expect(out).toContain('dag:       ')
    expect(out).toContain('mars-xyz')   // dag content serialised
    expect(out).toContain('Detailed body text')
  })

  it('finds a row by entity id', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-ent-1', entityId: 'mars-task-999', kind: 'failed-task' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'mars-task-999'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('id:        aq-ent-1')
  })

  it('finds a row by id prefix', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-prefix-abc123', entityId: 'mars-task-aaa' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-prefix-abc'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('id:        aq-prefix-abc123')
  })

  it('fetches with filter=all so dismissed rows are findable', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [makeRow({ id: 'aq-dis-1', dismissed: true })],
    })
    vi.stubGlobal('fetch', mockFetch)
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-dis-1'], opts)

    expect(r.code).toBe(0)
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('filter=all'))
  })

  it('returns code 1 when no matching row exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [makeRow({ id: 'aq-other' })],
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-missing'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no action queue item matching aq-missing')
  })

  it('fails with daemon-not-running message when http.port is absent', async () => {
    // No http.port file written.
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-any'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
    expect(r.err.join('\n')).toContain('mars daemon start')
    expect(r.out).toHaveLength(0)
  })

  it('fails with daemon-not-running message when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-any'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('daemon not running')
  })

  it('returns usage error when no id is provided', async () => {
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('usage: mars action-queue show <id>')
  })
})
