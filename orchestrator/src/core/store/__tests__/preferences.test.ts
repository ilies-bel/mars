/**
 * Tests for the `preferences` table and its helpers:
 *   - `getNotificationsEnabled(db)` — default true, roundtrip
 *   - `setNotificationsEnabled(db, enabled)` — upsert, idempotent
 *   - `migrateStateSchema()` — idempotent on second call
 *
 * Follows the same isolation pattern as task-store.test.ts:
 * `vi.resetModules()` + a fresh temp-dir git repo for each test group,
 * backed by a file-URL libsql client (`:memory:` has known write-tx issues).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// ── Helpers ───────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prefs-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadDeps = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const storeModule = await import('../state-store')
  const clientModule = await import('../state-client')
  await storeModule.migrateStateSchema()
  const db = clientModule.resolveStateClient()
  return { storeModule, db }
}

// ── Suites ────────────────────────────────────────────────────────────────────

describe('preferences — notifications_enabled', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('default is true when no row exists', async () => {
    const { storeModule, db } = await loadDeps(repo)
    expect(await storeModule.getNotificationsEnabled(db)).toBe(true)
  })

  it('set→get roundtrip: false', async () => {
    const { storeModule, db } = await loadDeps(repo)
    await storeModule.setNotificationsEnabled(db, false)
    expect(await storeModule.getNotificationsEnabled(db)).toBe(false)
  })

  it('set→get roundtrip: true', async () => {
    const { storeModule, db } = await loadDeps(repo)
    await storeModule.setNotificationsEnabled(db, true)
    expect(await storeModule.getNotificationsEnabled(db)).toBe(true)
  })

  it('set is idempotent — repeated calls do not throw or duplicate', async () => {
    const { storeModule, db } = await loadDeps(repo)
    await storeModule.setNotificationsEnabled(db, true)
    await storeModule.setNotificationsEnabled(db, true)
    await storeModule.setNotificationsEnabled(db, false)
    expect(await storeModule.getNotificationsEnabled(db)).toBe(false)
  })

  it('migrateStateSchema is idempotent — second call preserves stored value', async () => {
    const { storeModule, db } = await loadDeps(repo)
    await storeModule.setNotificationsEnabled(db, false)
    // Simulate daemon restart: re-run the migration
    await storeModule.migrateStateSchema()
    expect(await storeModule.getNotificationsEnabled(db)).toBe(false)
  })
})
