/**
 * Tests for loadOrBuildIndexCard (PRD 74d76a78 Phase 4A, slice 2 of 6).
 *
 * Coverage:
 *  - Cache miss: calls buildIndexCard and writes `.mars/index-cards/<key>.txt`.
 *  - Cache hit: returns the persisted text without rewriting (mtime unchanged).
 *  - Two calls with identical inputs produce the same cacheKey.
 *  - Two calls with different commitSha produce different cacheKeys.
 *  - cacheHit flag is false on miss and true on hit.
 *  - Returned text on a hit matches the on-disk file content.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context.js'
import { loadOrBuildIndexCard } from './cache.js'

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let repoDir: string

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'mars-index-card-cache-test-'))
  mkdirSync(join(repoDir, '.mars'))
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()
})

afterEach(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
  rmSync(repoDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleArgs = () => ({
  taskId: 'mars-cache-test-01',
  commitSha: 'abc1234567890abcdef1234567890abcdef123456',
  files: ['orchestrator/src/core/queue.ts', 'orchestrator/src/workflows/primitives/shared.ts'],
})

// ---------------------------------------------------------------------------
// Cache miss
// ---------------------------------------------------------------------------

describe('loadOrBuildIndexCard — cache miss', () => {
  it('returns cacheHit=false on the first call', () => {
    const result = loadOrBuildIndexCard(sampleArgs())
    expect(result.cacheHit).toBe(false)
  })

  it('writes the card text to .mars/index-cards/<cacheKey>.txt', () => {
    const result = loadOrBuildIndexCard(sampleArgs())
    const expectedPath = join(repoDir, '.mars', 'index-cards', `${result.cacheKey}.txt`)
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath, 'utf8')).toBe(result.text)
  })

  it('returns non-empty text containing the task id', () => {
    const result = loadOrBuildIndexCard(sampleArgs())
    expect(result.text.length).toBeGreaterThan(0)
    expect(result.text).toContain('mars-cache-test-01')
  })

  it('returns tokens > 0', () => {
    const result = loadOrBuildIndexCard(sampleArgs())
    expect(result.tokens).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Cache hit — mtime preserved
// ---------------------------------------------------------------------------

describe('loadOrBuildIndexCard — cache hit', () => {
  it('returns cacheHit=true on the second call with same inputs', () => {
    loadOrBuildIndexCard(sampleArgs()) // prime the cache
    const second = loadOrBuildIndexCard(sampleArgs())
    expect(second.cacheHit).toBe(true)
  })

  it('does NOT rewrite the cache file on a hit (mtime is unchanged)', () => {
    const first = loadOrBuildIndexCard(sampleArgs())
    const cachePath = join(repoDir, '.mars', 'index-cards', `${first.cacheKey}.txt`)
    const mtimeBefore = statSync(cachePath).mtimeMs
    loadOrBuildIndexCard(sampleArgs()) // second call — must be a cache hit
    const mtimeAfter = statSync(cachePath).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  it('returns the same text as what is in the cache file', () => {
    const first = loadOrBuildIndexCard(sampleArgs())
    const second = loadOrBuildIndexCard(sampleArgs())
    const cachePath = join(repoDir, '.mars', 'index-cards', `${first.cacheKey}.txt`)
    const onDisk = readFileSync(cachePath, 'utf8')
    expect(second.text).toBe(onDisk)
  })

  it('returns the same cacheKey on hit as on miss', () => {
    const first = loadOrBuildIndexCard(sampleArgs())
    const second = loadOrBuildIndexCard(sampleArgs())
    expect(second.cacheKey).toBe(first.cacheKey)
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('loadOrBuildIndexCard — determinism', () => {
  it('produces the same cacheKey for identical inputs', () => {
    const a = loadOrBuildIndexCard(sampleArgs())
    // Use a fresh repo dir for the second call to avoid a cache hit.
    const repoDir2 = mkdtempSync(join(tmpdir(), 'mars-index-card-cache-det-'))
    mkdirSync(join(repoDir2, '.mars'))
    process.env.MARS_REPO = repoDir2
    __resetContextCacheForTests()
    try {
      const b = loadOrBuildIndexCard(sampleArgs())
      expect(b.cacheKey).toBe(a.cacheKey)
    } finally {
      process.env.MARS_REPO = repoDir
      __resetContextCacheForTests()
      rmSync(repoDir2, { recursive: true, force: true })
    }
  })

  it('produces different cacheKeys when commitSha changes', () => {
    const a = loadOrBuildIndexCard(sampleArgs())
    const b = loadOrBuildIndexCard({ ...sampleArgs(), commitSha: 'deadbeef' })
    expect(b.cacheKey).not.toBe(a.cacheKey)
  })

  it('produces different cacheKeys when files change', () => {
    const a = loadOrBuildIndexCard(sampleArgs())
    const b = loadOrBuildIndexCard({
      ...sampleArgs(),
      files: [...sampleArgs().files, 'orchestrator/src/extra.ts'],
    })
    expect(b.cacheKey).not.toBe(a.cacheKey)
  })

  it('produces the same cacheKey regardless of file order', () => {
    const files = sampleArgs().files
    const a = loadOrBuildIndexCard({ ...sampleArgs(), files })
    const b = loadOrBuildIndexCard({ ...sampleArgs(), files: [...files].reverse() })
    expect(b.cacheKey).toBe(a.cacheKey)
  })
})

// ---------------------------------------------------------------------------
// Cache dir auto-creation
// ---------------------------------------------------------------------------

describe('loadOrBuildIndexCard — directory auto-creation', () => {
  it('creates the index-cards directory when it does not exist', () => {
    const cardDir = join(repoDir, '.mars', 'index-cards')
    expect(existsSync(cardDir)).toBe(false)
    loadOrBuildIndexCard(sampleArgs())
    expect(existsSync(cardDir)).toBe(true)
  })
})
