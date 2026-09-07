/**
 * Unit tests for domain-flow/store.ts (PRD cd54a867, slice 2).
 *
 * All tests share one PGlite instance (single beforeAll / afterAll) to avoid
 * WASM filesystem re-initialisation errors when multiple describe blocks each
 * spin up their own PGlite instance in the same vitest worker.
 *
 * A minimal `tasks` row is inserted before each test that exercises the store,
 * because `domain_flows.arc_id` references `tasks.id` via an ON DELETE CASCADE
 * FK. The task row is cleaned up after each test by deleting the domain_flows
 * row (ON DELETE CASCADE removes it automatically when the task is deleted).
 *
 * Covered cases:
 *   - create: upsertFlow inserts a new row and returns a DomainFlow
 *   - read:   getFlowByArcId returns the persisted row (or null when absent)
 *   - update: a second upsertFlow replaces nodes/name on an unfrozen flow
 *   - freeze: freezeFlow stamps frozen_at and returns the updated row;
 *             a second freezeFlow call is a no-op (frozen_at unchanged)
 *   - delete: deleteFlow removes the row; getFlowByArcId returns null afterward
 *   - frozen-immutability: upsertFlow on a frozen flow throws
 *   - missing-arc: upsertFlow with an arcId that has no tasks row throws a FK error
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── Shared fixture ────────────────────────────────────────────────────────────

let repo: string
let storeModule: typeof import('./store.js')
let queueModule: {
  resolveQueueClient: () => import('../lib/db.js').DbClient
  migrateQueueSchema: () => Promise<void>
}

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-domain-flow-store-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })

  process.env.MARS_REPO = repo
  process.env.MARS_DB_BACKEND = 'pglite'

  // Dynamic import so the PGlite backend picks up the env vars above.
  const q = await import('../queue.js')
  queueModule = {
    resolveQueueClient: q.resolveQueueClient,
    migrateQueueSchema: q.migrateQueueSchema,
  }
  await queueModule.migrateQueueSchema()

  storeModule = await import('./store.js')
})

afterAll(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  rmSync(repo, { recursive: true, force: true })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Insert a minimal tasks row so arc_id FK constraints are satisfied. */
async function insertTask(id: string): Promise<void> {
  const client = queueModule.resolveQueueClient()
  await client.execute({
    sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
          VALUES ($1, 'test task', 'queued', now(), now())`,
    args: [id],
  })
}

/** Delete a tasks row (cascades to domain_flows). */
async function deleteTask(id: string): Promise<void> {
  const client = queueModule.resolveQueueClient()
  await client.execute({
    sql: `DELETE FROM tasks WHERE id = $1`,
    args: [id],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('domain-flow store', () => {
  let arcId: string

  beforeEach(async () => {
    arcId = `task-${randomUUID()}`
    await insertTask(arcId)
  })

  afterEach(async () => {
    // Cascades to domain_flows row.
    await deleteTask(arcId)
  })

  it('create: upsertFlow inserts a new row and returns a DomainFlow', async () => {
    const client = queueModule.resolveQueueClient()
    const nodes = [
      { kind: 'event' as const, name: 'OrderPlaced', description: 'Customer places an order', pivotal: true },
    ]

    const flow = await storeModule.upsertFlow(client, arcId, 'Order flow', nodes)

    expect(flow.arcId).toBe(arcId)
    expect(flow.name).toBe('Order flow')
    expect(flow.nodes).toHaveLength(1)
    expect(flow.nodes[0]).toMatchObject({ kind: 'event', name: 'OrderPlaced' })
    expect(flow.frozenAt).toBeNull()
    expect(typeof flow.id).toBe('string')
    expect(typeof flow.createdAt).toBe('string')
    expect(typeof flow.updatedAt).toBe('string')
  })

  it('read: getFlowByArcId returns null when no flow exists', async () => {
    const client = queueModule.resolveQueueClient()
    const result = await storeModule.getFlowByArcId(client, arcId)
    expect(result).toBeNull()
  })

  it('read: getFlowByArcId returns the persisted flow', async () => {
    const client = queueModule.resolveQueueClient()
    const nodes = [
      { kind: 'policy' as const, name: 'SendConfirmation', description: 'Send email' },
    ]
    await storeModule.upsertFlow(client, arcId, 'Notification flow', nodes)

    const result = await storeModule.getFlowByArcId(client, arcId)

    expect(result).not.toBeNull()
    expect(result!.arcId).toBe(arcId)
    expect(result!.name).toBe('Notification flow')
    expect(result!.nodes).toHaveLength(1)
    expect(result!.nodes[0]).toMatchObject({ kind: 'policy', name: 'SendConfirmation' })
  })

  it('update: a second upsertFlow replaces nodes and name', async () => {
    const client = queueModule.resolveQueueClient()
    await storeModule.upsertFlow(client, arcId, 'Initial name', [
      { kind: 'event' as const, name: 'A', description: '', pivotal: false },
    ])

    const updated = await storeModule.upsertFlow(client, arcId, 'Updated name', [
      { kind: 'hotspot' as const, name: 'B', question: 'Is this right?' },
    ])

    expect(updated.name).toBe('Updated name')
    expect(updated.nodes).toHaveLength(1)
    expect(updated.nodes[0]).toMatchObject({ kind: 'hotspot', name: 'B' })

    // Only one row for this arcId.
    const read = await storeModule.getFlowByArcId(client, arcId)
    expect(read!.name).toBe('Updated name')
  })

  it('freeze: freezeFlow stamps frozen_at', async () => {
    const client = queueModule.resolveQueueClient()
    await storeModule.upsertFlow(client, arcId, 'Flow to freeze', [
      { kind: 'event' as const, name: 'X', description: 'desc', pivotal: false },
    ])

    const frozen = await storeModule.freezeFlow(client, arcId)

    expect(frozen.frozenAt).not.toBeNull()
    expect(typeof frozen.frozenAt).toBe('string')
    // The read-back also reflects the frozen state.
    const readBack = await storeModule.getFlowByArcId(client, arcId)
    expect(readBack!.frozenAt).not.toBeNull()
  })

  it('freeze: a second freezeFlow call is a no-op (frozen_at unchanged)', async () => {
    const client = queueModule.resolveQueueClient()
    await storeModule.upsertFlow(client, arcId, 'Flow', [
      { kind: 'event' as const, name: 'Y', description: '', pivotal: false },
    ])
    const first = await storeModule.freezeFlow(client, arcId)
    const firstTs = first.frozenAt

    // Small delay to make a timestamp difference observable if a second UPDATE ran.
    await new Promise((r) => setTimeout(r, 5))

    const second = await storeModule.freezeFlow(client, arcId)
    expect(second.frozenAt).toBe(firstTs)
  })

  it('delete: deleteFlow removes the row', async () => {
    const client = queueModule.resolveQueueClient()
    await storeModule.upsertFlow(client, arcId, 'To delete', [])

    await storeModule.deleteFlow(client, arcId)

    const result = await storeModule.getFlowByArcId(client, arcId)
    expect(result).toBeNull()
  })

  it('delete: deleteFlow on a non-existent flow is a no-op', async () => {
    const client = queueModule.resolveQueueClient()
    // Should not throw.
    await expect(storeModule.deleteFlow(client, arcId)).resolves.toBeUndefined()
  })

  it('frozen-immutability: upsertFlow on a frozen flow throws', async () => {
    const client = queueModule.resolveQueueClient()
    await storeModule.upsertFlow(client, arcId, 'Frozen flow', [
      { kind: 'event' as const, name: 'Z', description: '', pivotal: false },
    ])
    await storeModule.freezeFlow(client, arcId)

    await expect(
      storeModule.upsertFlow(client, arcId, 'Mutated name', []),
    ).rejects.toThrow(/frozen/)
  })

  it('node validation: upsertFlow throws on invalid nodes', async () => {
    const client = queueModule.resolveQueueClient()
    const badNodes = [{ kind: 'unknown', name: 'Bad' }] as never

    await expect(
      storeModule.upsertFlow(client, arcId, 'Flow', badNodes),
    ).rejects.toThrow()
  })

  it('missing-arc: upsertFlow with a non-existent arcId throws a FK error', async () => {
    const client = queueModule.resolveQueueClient()
    const nonExistentArcId = `task-${randomUUID()}-does-not-exist`

    await expect(
      storeModule.upsertFlow(client, nonExistentArcId, 'Orphan flow', []),
    ).rejects.toThrow()
  })
})
