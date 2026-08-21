/**
 * queue.origin_id migration/default coverage.
 *
 * Pre-migration-0002 (SQLite/libsql), `migrateQueueSchema` was a ~1300-line
 * imperative introspection engine that added `origin_id` to a stale DB and
 * backfilled existing rows. Post-0002 the store is embedded PostgreSQL
 * (PGlite in tests) and `migrateQueueSchema` is a compatibility alias for
 * `ensureQueueSchema`, which just runs the canonical, idempotent DDL from
 * `core/lib/pg-schema.ts` (see queue.ts:658-687) — the `tasks` table is
 * always created with `origin_id` already present, so there is no "legacy
 * DB missing the column" state to backfill any more. That coverage was
 * dropped rather than ported; what remains here is schema idempotency plus
 * the default/explicit `origin_id` behaviour on insert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueMod {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  enqueueTask: typeof import('../../queue').enqueueTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-origin-id-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<QueueMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../queue')
  await mod.migrateQueueSchema()
  return mod as unknown as QueueMod
}

describe('queue.origin_id migration', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('migrateQueueSchema is idempotent: running twice does not duplicate the column', async () => {
    const q = await loadQueue(repo)
    await q.migrateQueueSchema()
    await q.migrateQueueSchema()

    const cols = await q.resolveQueueClient().execute({
      sql: `SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'origin_id'`,
      args: [],
    })
    expect(cols.rows).toHaveLength(1)
  })

  it('new tasks get origin_id = id by default (direct mars task add)', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    expect(t.originId).toBe(t.id)

    const r = await q.resolveQueueClient().execute({
      sql: `SELECT origin_id FROM tasks WHERE id = ?`,
      args: [t.id],
    })
    expect((r.rows[0] as unknown as { origin_id: string }).origin_id).toBe(t.id)
  })

  it('enqueueTask honours explicit originId option (proposal-originated tasks)', async () => {
    const q = await loadQueue(repo)
    const proposalId = 'proposal-abc-12345678'
    const t = await q.enqueueTask('from proposal', undefined, {
      skipTriage: true,
      originId: proposalId,
    })
    expect(t.originId).toBe(proposalId)
  })
})
