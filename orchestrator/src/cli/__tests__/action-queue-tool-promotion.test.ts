/**
 * Behavioural tests for 'tool-promotion' action-queue support.
 *
 * Covers:
 *   (a) raise-schema accepts kind='tool-promotion' with the typed payload,
 *   (b) the repopulator scan emits one row per benchmarked attempt,
 *   (c) re-scanning is idempotent (no duplicate rows),
 *   (d) `mars action-queue show <id>` renders helperKey, arc ids, and a
 *       before/after benchmark table for tool-promotion rows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { actionQueueRaiseSchema } from '../action-queue-raise-schema'
import {
  runCommandInProcess,
  makeFakeDaemon,
  type InProcessOptions,
} from '../test-adapter'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FAKE_PORT = 19998

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-aq-tool-promo-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const writeDaemonPort = (repoDir: string, port: number): void => {
  writeFileSync(join(repoDir, '.mars', 'http.port'), String(port))
}

// ---------------------------------------------------------------------------
// (a) Raise-schema acceptance
// ---------------------------------------------------------------------------

describe('actionQueueRaiseSchema — tool-promotion kind', () => {
  const validToolPromotion = {
    kind: 'tool-promotion' as const,
    category: 'reflector',
    priority: 'normal' as const,
    title: 'Helper ready: myHelper',
    body: 'Review benchmark evidence.',
    payload: {
      attemptId: 'attempt-abc-123',
      helperKey: 'myHelper',
      before: { p50: 100, p95: 200 },
      after: { p50: 40, p95: 80 },
      motivatingArcIds: ['arc-001', 'arc-002'],
    },
    context: {},
    raisedBy: 'test',
    signature: 'tool-promotion:attempt-abc-123',
  }

  it('accepts kind=tool-promotion with a full typed payload', () => {
    const result = actionQueueRaiseSchema.safeParse(validToolPromotion)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.kind).toBe('tool-promotion')
      expect(result.data.payload['attemptId']).toBe('attempt-abc-123')
      expect(result.data.payload['helperKey']).toBe('myHelper')
      expect(result.data.payload['motivatingArcIds']).toEqual(['arc-001', 'arc-002'])
    }
  })

  it('accepts tool-promotion when before/after are null (optional evidence)', () => {
    const withNulls = {
      ...validToolPromotion,
      payload: { ...validToolPromotion.payload, before: null, after: null },
    }
    const result = actionQueueRaiseSchema.safeParse(withNulls)
    expect(result.success).toBe(true)
  })

  it('rejects tool-promotion when payload is not a record', () => {
    const bad = { ...validToolPromotion, payload: 'not-a-record' as unknown as Record<string, unknown> }
    const result = actionQueueRaiseSchema.safeParse(bad)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (b + c) Repopulator scan — drainToolPromotionLedger
// ---------------------------------------------------------------------------

interface QueueModule {
  migrateQueueSchema: typeof import('../../core/queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../core/queue').resolveQueueClient
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../core/lib/action-queue').listActionQueueItems
}

interface RepopulatorModule {
  drainToolPromotionLedger: typeof import('../../core/daemon/action-queue-repopulator').drainToolPromotionLedger
}

interface Loaded {
  q: QueueModule
  actionQueue: ActionQueueModule
  rep: RepopulatorModule
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../core/queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../core/lib/action-queue')) as unknown as ActionQueueModule
  const rep = (await import(
    '../../core/daemon/action-queue-repopulator'
  )) as unknown as RepopulatorModule
  return { q, actionQueue, rep }
}

let repo: string

beforeEach(() => {
  repo = setupRepo()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

describe('drainToolPromotionLedger — repopulator scan', () => {
  it('raises one action-queue row per benchmarked attempt', async () => {
    const { q, actionQueue, rep } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const now = Date.now()

    await client.execute({
      sql: `INSERT INTO tool_promotion_attempts
              (id, helper_key, status, benchmark_before, benchmark_after, motivating_arc_ids, created_at)
            VALUES (?, ?, 'benchmarked', ?, ?, ?, ?)`,
      args: [
        'attempt-001',
        'fastHelper',
        JSON.stringify({ p50: 120 }),
        JSON.stringify({ p50: 45 }),
        JSON.stringify(['arc-aaa', 'arc-bbb']),
        now,
      ],
    })

    const { raised } = await rep.drainToolPromotionLedger(client)
    expect(raised).toBe(1)

    const open = await actionQueue.listActionQueueItems('open')
    const row = open.find((i) => i.payload['attemptId'] === 'attempt-001')
    expect(row).toBeDefined()
    expect(row!.kind).toBe('tool-promotion')
    expect(row!.payload['helperKey']).toBe('fastHelper')
    expect(row!.payload['motivatingArcIds']).toEqual(['arc-aaa', 'arc-bbb'])
  })

  it('does not duplicate rows on re-scan (idempotent by attemptId)', async () => {
    const { q, actionQueue, rep } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const now = Date.now()

    await client.execute({
      sql: `INSERT INTO tool_promotion_attempts
              (id, helper_key, status, benchmark_before, benchmark_after, motivating_arc_ids, created_at)
            VALUES (?, ?, 'benchmarked', NULL, NULL, '[]', ?)`,
      args: ['attempt-idem', 'dedupHelper', now],
    })

    // First scan
    const { raised: first } = await rep.drainToolPromotionLedger(client)
    expect(first).toBe(1)

    // Second scan — same attempt, already raised
    const { raised: second } = await rep.drainToolPromotionLedger(client)
    expect(second).toBe(1) // raise was called again (idempotent — bumps seen_count)

    // Only one open row despite two scan passes
    const open = await actionQueue.listActionQueueItems('open')
    const rows = open.filter((i) => i.payload['attemptId'] === 'attempt-idem')
    expect(rows).toHaveLength(1)
    expect(rows[0].seenCount).toBe(2) // second scan bumped seen_count
  })

  it('skips attempts with status other than benchmarked', async () => {
    const { q, actionQueue, rep } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const now = Date.now()

    await client.execute({
      sql: `INSERT INTO tool_promotion_attempts
              (id, helper_key, status, benchmark_before, benchmark_after, motivating_arc_ids, created_at)
            VALUES (?, ?, 'proposed', NULL, NULL, '[]', ?)`,
      args: ['attempt-pending', 'notYetHelper', now],
    })

    const { raised } = await rep.drainToolPromotionLedger(client)
    expect(raised).toBe(0)

    const open = await actionQueue.listActionQueueItems('open')
    expect(open.filter((i) => i.payload['attemptId'] === 'attempt-pending')).toHaveLength(0)
  })

  it('raises multiple rows when multiple benchmarked attempts exist', async () => {
    const { q, actionQueue, rep } = await loadModules(repo)
    const client = q.resolveQueueClient()
    const now = Date.now()

    for (const id of ['attempt-m1', 'attempt-m2', 'attempt-m3']) {
      await client.execute({
        sql: `INSERT INTO tool_promotion_attempts
                (id, helper_key, status, benchmark_before, benchmark_after, motivating_arc_ids, created_at)
              VALUES (?, ?, 'benchmarked', NULL, NULL, '[]', ?)`,
        args: [id, `helper-${id}`, now],
      })
    }

    const { raised } = await rep.drainToolPromotionLedger(client)
    expect(raised).toBe(3)

    const open = await actionQueue.listActionQueueItems('open')
    const toolPromoRows = open.filter((i) => i.kind === 'tool-promotion')
    expect(toolPromoRows).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// (d) Show rendering — helperKey, arcIds, and benchmark table
// ---------------------------------------------------------------------------

/** Build a minimal InProcessOptions backed by a real DB. */
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

/** Build a minimal ActionQueueRow for a tool-promotion item. */
const makeToolPromotionRow = (
  id: string,
  detail: NonNullable<ActionQueueRow['toolPromotionDetail']>,
): ActionQueueRow => ({
  id,
  kind: 'tool-promotion',
  entityId: `attempt-${id}`,
  priority: 'normal',
  title: `Helper ready for promotion: ${detail.helperKey}`,
  body: `Benchmark evidence is available for helper \`${detail.helperKey}\`.`,
  at: '2026-07-19T00:00:00.000Z',
  dag: null,
  errorKind: 'tool-promotion',
  actions: [],
  staleWorktreeDetail: null,
  devServerUrl: null,
  leaseState: null,
  diagnosis: null,
  failureReasonCode: null,
  humanSummary: `Helper "${detail.helperKey}" has benchmark evidence ready for review.`,
  humanDetail: { helperKey: detail.helperKey },
  verbs: [],
  toolPromotionDetail: detail,
})

describe('action-queue show — tool-promotion rendering', () => {
  it('prints helperKey, arc ids, and before/after benchmark table', async () => {
    const detail: NonNullable<ActionQueueRow['toolPromotionDetail']> = {
      helperKey: 'myFastHelper',
      motivatingArcIds: ['arc-x1', 'arc-x2'],
      before: { p50: 150, p95: 300 },
      after: { p50: 55, p95: 110 },
    }
    const rows: ActionQueueRow[] = [makeToolPromotionRow('aq-tp-001', detail)]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-tp-001'], opts)

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    // Standard header fields
    expect(out).toContain('kind:      tool-promotion')
    // Tool-promotion specific fields
    expect(out).toContain('myFastHelper')
    expect(out).toContain('arc-x1')
    expect(out).toContain('arc-x2')
    // Before/after benchmark table
    expect(out).toContain('before')
    expect(out).toContain('after')
    expect(out).toContain('150')  // before p50
    expect(out).toContain('55')   // after p50
  })

  it('renders the body before the tool-promotion detail section', async () => {
    const detail: NonNullable<ActionQueueRow['toolPromotionDetail']> = {
      helperKey: 'anotherHelper',
      motivatingArcIds: ['arc-y1'],
      before: { p50: 200 },
      after: { p50: 80 },
    }
    const rows: ActionQueueRow[] = [
      makeToolPromotionRow('aq-tp-002', detail),
    ]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-tp-002'], opts)

    expect(r.code).toBe(0)
    const combined = r.out.join('\n')
    const bodyIdx = combined.indexOf('Benchmark evidence is available')
    // The 'helper:' label appears in the detail section (after the body)
    const detailLabelIdx = combined.indexOf('helper:')
    expect(bodyIdx).toBeGreaterThanOrEqual(0)
    expect(detailLabelIdx).toBeGreaterThan(bodyIdx)
  })

  it('standard show fields still render on tool-promotion rows', async () => {
    const detail: NonNullable<ActionQueueRow['toolPromotionDetail']> = {
      helperKey: 'stdHelper',
      motivatingArcIds: [],
      before: null,
      after: null,
    }
    const rows: ActionQueueRow[] = [makeToolPromotionRow('aq-tp-std', detail)]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }))
    writeDaemonPort(repo, FAKE_PORT)
    const opts = await loadOpts(repo)

    const r = await runCommandInProcess(['action-queue', 'show', 'aq-tp-std'], opts)

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('id:        aq-tp-std')
    expect(out).toContain('kind:      tool-promotion')
    expect(out).toContain('priority:  normal')
  })
})
