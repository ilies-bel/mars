/**
 * Tests for the humanSummary/class/humanDetail rendering introduced in
 * slice 2 of PRD 02b31f37.
 *
 * Covers:
 *   (a) `list` — class column ([ALERT]/[NOTICE]/[DECISION]) after kind
 *   (b) `list` — humanSummary as last column, falling back to title
 *   (c) `list --lean` — humanSummary in preview rows
 *   (d) `show` — humanSummary as headline, class label on first line
 *   (e) `show` — secondary title line only when title differs from humanSummary
 *   (f) `show` — humanDetail block rendered as indented key-value pairs
 *   (g) tab-separated stdout contract preserved (class is new 4th column)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCommandInProcess, makeFakeDaemon, type InProcessOptions } from '../test-adapter'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

const FAKE_PORT = 19998

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-aq-rendering-test-'))
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

/** Build a minimal ActionQueueRow with sensible rendering defaults. */
const makeRow = (
  overrides: Partial<ActionQueueRow> & Pick<ActionQueueRow, 'id'>,
): ActionQueueRow => ({
  kind: 'failed',
  entityId: `entity-${overrides.id}`,
  priority: 'normal',
  title: `Title for ${overrides.id}`,
  body: `Body for ${overrides.id}`,
  at: '2026-01-01T00:00:00.000Z',
  dag: null,
  errorKind: 'unknown',
  actions: [],
  staleWorktreeDetail: null,
  devServerUrl: null,
  leaseState: null,
  diagnosis: null,
  failureReasonCode: null,
  recoveryExhausted: false,
  fixForTaskId: null,
  arcGoal: null,
  operatorGoal: null,
  goalIsInherited: false,
  humanSummary: `Summary for ${overrides.id}`,
  humanDetail: {},
  verbs: [],
  class: 'alert',
  noticeKey: null,
  ...overrides,
} as ActionQueueRow)

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// list — class column
// ---------------------------------------------------------------------------

describe('action-queue list — class column', () => {
  it('includes [ALERT] class column after kind for alert items', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-a1', kind: 'failed', class: 'alert', humanSummary: 'Task failed' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    expect(combined).toContain('aq-a1\tnormal\tfailed\t[ALERT]\tTask failed')
  })

  it('includes [NOTICE] class column for notice items', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-n1', kind: 'failed', class: 'notice', humanSummary: 'Repair in progress' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('[NOTICE]')
  })

  it('includes [DECISION] class column for decision items', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-d1', kind: 'draft-proposal', class: 'decision', humanSummary: 'Approve proposal' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open', '--kind', 'draft-proposal'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('[DECISION]')
  })
})

// ---------------------------------------------------------------------------
// list — humanSummary column
// ---------------------------------------------------------------------------

describe('action-queue list — humanSummary column', () => {
  it('shows humanSummary as the last (5th) column', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-1', humanSummary: 'The task failed due to a network error' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(0)
    const line = r.out.find((l) => l.startsWith('aq-1\t'))
    expect(line).toBeDefined()
    expect(line).toContain('The task failed due to a network error')
  })

  it('falls back to title when humanSummary is empty', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-2', humanSummary: '', title: 'Original title text' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    expect(combined).toContain('Original title text')
  })

  it('preserves 5-column tab-separated stdout contract (id, priority, kind, class, summary)', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-3', priority: 'high', kind: 'failed', class: 'alert', humanSummary: 'Failure msg' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open'], opts)

    expect(r.code).toBe(0)
    const line = r.out.find((l) => l.startsWith('aq-3\t'))!
    expect(line).toBeDefined()
    const cols = line.split('\t')
    expect(cols).toHaveLength(5)
    expect(cols[0]).toBe('aq-3')
    expect(cols[1]).toBe('high')
    expect(cols[2]).toBe('failed')
    expect(cols[3]).toBe('[ALERT]')
    expect(cols[4]).toBe('Failure msg')
  })
})

// ---------------------------------------------------------------------------
// list --lean — humanSummary in preview rows
// ---------------------------------------------------------------------------

describe('action-queue list --lean — humanSummary preview', () => {
  it('uses humanSummary in preview rows instead of title', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-lean-1', humanSummary: 'Human-readable summary', title: 'Raw internal title' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open', '--lean'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    expect(combined).toContain('aq-lean-1')
    expect(combined).toContain('Human-readable summary')
    expect(combined).not.toContain('Raw internal title')
  })

  it('falls back to title when humanSummary is empty in lean preview', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-lean-2', humanSummary: '', title: 'Lean title fallback' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'list', 'open', '--lean'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    expect(combined).toContain('aq-lean-2')
    expect(combined).toContain('Lean title fallback')
  })
})

// ---------------------------------------------------------------------------
// show — humanSummary headline and class label
// ---------------------------------------------------------------------------

describe('action-queue show — humanSummary headline', () => {
  it('renders [CLASS] + humanSummary on the first output line', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-show-1', class: 'alert', humanSummary: 'Task timed out waiting for provider' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-show-1'], opts)

    expect(r.code).toBe(0)
    const firstLine = r.out[0]
    expect(firstLine).toContain('[ALERT]')
    expect(firstLine).toContain('Task timed out waiting for provider')
  })

  it('shows title as secondary line when it differs from humanSummary', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({
        id: 'aq-show-2',
        humanSummary: 'Mars could not connect to the provider',
        title: 'verify:connect failed',
      }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-show-2'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    expect(combined).toContain('Mars could not connect to the provider')
    // Secondary title line is present when headline differs from title
    expect(combined).toContain('title:     verify:connect failed')
  })

  it('does not show secondary title line when title equals humanSummary', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({
        id: 'aq-show-3',
        humanSummary: 'Same text for both',
        title: 'Same text for both',
      }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-show-3'], opts)

    expect(r.code).toBe(0)
    // headline appears exactly once — no duplicate secondary line
    const occurrences = r.out.filter((l) => l.includes('Same text for both'))
    expect(occurrences).toHaveLength(1)
  })

  it('falls back to title as headline when humanSummary is empty', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-show-4', humanSummary: '', title: 'Fallback headline title' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-show-4'], opts)

    expect(r.code).toBe(0)
    const firstLine = r.out[0]
    expect(firstLine).toContain('Fallback headline title')
    // No secondary title line when humanSummary is empty (title IS the headline)
    expect(r.out.filter((l) => l.includes('title:     Fallback headline title'))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// show — humanDetail block
// ---------------------------------------------------------------------------

describe('action-queue show — humanDetail block', () => {
  it('renders non-empty humanDetail fields as indented key-value block', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({
        id: 'aq-detail-1',
        humanDetail: {
          failureSignature: 'verify:typecheck',
          branch: 'task/mars-abc123',
        },
      }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-detail-1'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    expect(combined).toContain('  failureSignature: verify:typecheck')
    expect(combined).toContain('  branch: task/mars-abc123')
  })

  it('omits humanDetail block when humanDetail is empty', async () => {
    // Set humanSummary === title so no secondary title line appears either,
    // making the assertion about "no indented key-value block" unambiguous.
    const rows: ActionQueueRow[] = [
      makeRow({ id: 'aq-detail-2', humanDetail: {}, humanSummary: 'Same', title: 'Same' }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-detail-2'], opts)

    expect(r.code).toBe(0)
    // Body is present; no spurious extra blank line after it from the detail block
    const combined = r.out.join('\n')
    expect(combined).toContain(`Body for aq-detail-2`)
    // humanDetail lines use exactly one space after the colon (  key: value).
    // No such lines should appear when humanDetail is empty.
    const humanDetailLines = r.out.filter((l) => /^  \w+: \S/.test(l))
    expect(humanDetailLines).toHaveLength(0)
  })

  it('omits null/undefined/empty-string humanDetail values', async () => {
    const rows: ActionQueueRow[] = [
      makeRow({
        id: 'aq-detail-3',
        humanDetail: {
          failureSignature: 'verify:typecheck',
          branch: null as unknown as string,
          worktree: undefined,
          changelog: '',
        },
      }),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-detail-3'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    expect(combined).toContain('  failureSignature: verify:typecheck')
    expect(combined).not.toContain('  branch:')
    expect(combined).not.toContain('  worktree:')
    expect(combined).not.toContain('  changelog:')
  })
})
