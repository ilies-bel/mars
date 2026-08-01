/**
 * Unit tests for the persisted `paused` flag in daemon.json.
 *
 * Covers `readPersistedPaused` and `persistPaused` — the two config helpers
 * introduced in ADR-0058 so a persisted dispatch pause survives a daemon restart.
 *
 * Test strategy: point `MARS_REPO` at a temp dir, manipulate daemon.json
 * directly, and verify the helpers read and write the expected values.
 * No daemon process is spawned.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import { readPersistedPaused, persistPaused } from '../config'

describe('readPersistedPaused', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-cfg-paused-'))
    mkdirSync(join(tmpDir, '.mars'), { recursive: true })
    process.env['MARS_REPO'] = tmpDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env['MARS_REPO']
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const writeDaemonJson = (content: unknown) =>
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify(content))

  it('returns false when daemon.json is absent', () => {
    expect(readPersistedPaused()).toBe(false)
  })

  it('returns false when daemon.json has no paused field', () => {
    writeDaemonJson({ caps: { implement: 12 } })
    expect(readPersistedPaused()).toBe(false)
  })

  it('returns false when paused field is false', () => {
    writeDaemonJson({ paused: false })
    expect(readPersistedPaused()).toBe(false)
  })

  it('returns false when paused field is a non-boolean truthy value', () => {
    writeDaemonJson({ paused: 1 })
    expect(readPersistedPaused()).toBe(false)
  })

  it('returns true when paused field is true', () => {
    writeDaemonJson({ paused: true })
    expect(readPersistedPaused()).toBe(true)
  })

  it('returns false when daemon.json contains invalid JSON', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), 'NOT_VALID_JSON')
    expect(readPersistedPaused()).toBe(false)
  })
})

describe('persistPaused', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-cfg-paused-persist-'))
    mkdirSync(join(tmpDir, '.mars'), { recursive: true })
    process.env['MARS_REPO'] = tmpDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env['MARS_REPO']
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const readDaemonJson = (): Record<string, unknown> => {
    const raw = readFileSync(join(tmpDir, '.mars', 'daemon.json'), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  }

  it('writes paused=true and readPersistedPaused returns true', () => {
    persistPaused(true)
    expect(readPersistedPaused()).toBe(true)
    expect(readDaemonJson().paused).toBe(true)
  })

  it('writing false removes the paused key entirely (minimal file)', () => {
    // First persist true, then persist false and verify the key is gone.
    persistPaused(true)
    expect(readDaemonJson().paused).toBe(true)
    persistPaused(false)
    const after = readDaemonJson()
    expect(after.paused).toBeUndefined()
    expect(readPersistedPaused()).toBe(false)
  })

  it('preserves other keys in daemon.json when persisting pause', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 5 } }),
    )
    persistPaused(true)
    const after = readDaemonJson()
    expect(after.paused).toBe(true)
    expect((after.caps as Record<string, unknown>).implement).toBe(5)
  })

  it('round-trips: persist true → read true → persist false → read false', () => {
    persistPaused(true)
    expect(readPersistedPaused()).toBe(true)
    persistPaused(false)
    expect(readPersistedPaused()).toBe(false)
  })
})
