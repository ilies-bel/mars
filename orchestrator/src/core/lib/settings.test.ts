/**
 * Unit tests for the app_settings KV store (getSetting / setSetting round-trip).
 *
 * Each test boots a fresh temp git repo with a `.mars/` directory and reloads
 * all modules so every test gets an isolated sqlite database, exactly as the
 * action-queue tests do.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface SettingsModule {
  initSettings: typeof import('./settings').initSettings
  getSetting: typeof import('./settings').getSetting
  setSetting: typeof import('./settings').setSetting
  RELEASE_NOTES_LAST_VIEWED_KEY: typeof import('./settings').RELEASE_NOTES_LAST_VIEWED_KEY
}

interface StateClientModule {
  resolveStateClient: typeof import('../store/state-client').resolveStateClient
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-settings-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ settings: SettingsModule; stateClient: StateClientModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const [settings, stateClient] = (await Promise.all([
    import('./settings'),
    import('../store/state-client'),
  ])) as [SettingsModule, StateClientModule]
  return { settings, stateClient }
}

describe('settings KV store', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null for a key that has never been set', async () => {
    const { settings, stateClient } = await loadModules(repo)
    await settings.initSettings()
    const db = stateClient.resolveStateClient()
    const val = await settings.getSetting(db, 'nonexistent.key')
    expect(val).toBeNull()
  })

  it('returns the stored value after a set', async () => {
    const { settings, stateClient } = await loadModules(repo)
    await settings.initSettings()
    const db = stateClient.resolveStateClient()
    await settings.setSetting(db, 'some.key', 'hello world')
    const val = await settings.getSetting(db, 'some.key')
    expect(val).toBe('hello world')
  })

  it('overwrites on second set and bumps updated_at', async () => {
    const { settings, stateClient } = await loadModules(repo)
    await settings.initSettings()
    const db = stateClient.resolveStateClient()

    await settings.setSetting(db, 'ts.key', 'first')
    // Read updated_at from the raw table after first write.
    const r1 = await db.execute({
      sql: 'SELECT updated_at FROM app_settings WHERE key = ?',
      args: ['ts.key'],
    })
    const updatedAt1 = r1.rows[0]?.updated_at as string
    expect(typeof updatedAt1).toBe('string')

    // Tiny delay so the ISO timestamp can advance.
    await new Promise<void>((resolve) => setTimeout(resolve, 2))

    await settings.setSetting(db, 'ts.key', 'second')
    const val2 = await settings.getSetting(db, 'ts.key')
    expect(val2).toBe('second')

    const r2 = await db.execute({
      sql: 'SELECT updated_at FROM app_settings WHERE key = ?',
      args: ['ts.key'],
    })
    const updatedAt2 = r2.rows[0]?.updated_at as string
    expect(updatedAt2).not.toBe(updatedAt1)
  })

  it('RELEASE_NOTES_LAST_VIEWED_KEY round-trips via setSetting/getSetting', async () => {
    const { settings, stateClient } = await loadModules(repo)
    await settings.initSettings()
    const db = stateClient.resolveStateClient()
    const ts = new Date().toISOString()
    await settings.setSetting(db, settings.RELEASE_NOTES_LAST_VIEWED_KEY, ts)
    const val = await settings.getSetting(db, settings.RELEASE_NOTES_LAST_VIEWED_KEY)
    expect(val).toBe(ts)
  })
})
