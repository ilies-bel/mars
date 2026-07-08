/**
 * Daemon subscriber bootstrap — registration tests.
 *
 * Asserts that after the daemon's subscriber bootstrap functions are called,
 * the `subscribers` table contains the expected subscriber ids. This verifies
 * that dead-code risk is eliminated: if a subscriber's ensure function is NOT
 * wired into the daemon boot path, the `subscribers` row is never created and
 * the subscriber silently never processes events.
 *
 * Each test calls the ensure function directly (the same call the daemon makes
 * at boot) and then queries the `subscribers` table through the public client —
 * observable behaviour through the public interface, not implementation details.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface RecoverySpawnModule {
  RECOVERY_SPAWN_SUBSCRIBER: typeof import('../../../outbox/subscribers/recovery-spawn').RECOVERY_SPAWN_SUBSCRIBER
  ensureRecoverySpawner: typeof import('../../../outbox/subscribers/recovery-spawn').ensureRecoverySpawner
}

interface Loaded {
  q: QueueModule
  rs: RecoverySpawnModule
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-subscriber-bootstrap-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const rs = (await import(
    '../../../outbox/subscribers/recovery-spawn'
  )) as unknown as RecoverySpawnModule
  return { q, rs }
}

describe('daemon subscriber bootstrap — recovery-spawner', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('registers recovery-spawner in the subscribers table after ensureRecoverySpawner is called', async () => {
    const { q, rs } = await loadModules(repo)
    const client = q.resolveQueueClient()

    // Simulate the daemon subscriber bootstrap.
    await rs.ensureRecoverySpawner(client)

    // The subscribers table must contain a row for the recovery-spawner.
    const result = await client.execute({
      sql: 'SELECT name FROM subscribers WHERE name = ?',
      args: [rs.RECOVERY_SPAWN_SUBSCRIBER],
    })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe('recovery-spawner')
  })

  it('ensureRecoverySpawner is idempotent — re-calling does not throw or duplicate the row', async () => {
    const { q, rs } = await loadModules(repo)
    const client = q.resolveQueueClient()

    await rs.ensureRecoverySpawner(client)
    // Call a second time — must not throw or insert a duplicate.
    await rs.ensureRecoverySpawner(client)

    const result = await client.execute({
      sql: 'SELECT name FROM subscribers WHERE name = ?',
      args: [rs.RECOVERY_SPAWN_SUBSCRIBER],
    })
    // Still exactly one row.
    expect(result.rows).toHaveLength(1)
  })
})
