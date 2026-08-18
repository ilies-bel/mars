/**
 * Unit tests for arc-qa-manifest: writeArcQaManifest / loadArcQaManifest.
 *
 * Covers:
 *  1. Round-trip: write then load returns the original manifest unchanged.
 *  2. Missing file: loadArcQaManifest returns null for a non-existent manifest.
 *  3. Malformed JSON: loadArcQaManifest returns null when the file is not valid JSON.
 *  4. Wrong shape: loadArcQaManifest returns null when the JSON has the wrong shape.
 *  5. Idempotent write: writing twice produces the latest value.
 *  6. Path layout: manifest is written inside .mars/arc-qa/<originId>/.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RaiseActionQueueItem } from '../action-queue'

// ── Mock raiseActionQueueItem so maybeSuggestPromotion tests don't hit the DB ─

const raiseSpy = vi.hoisted(() =>
  vi.fn(async (_item: RaiseActionQueueItem): Promise<string> => 'mock-item-id'),
)
vi.mock('../action-queue', async (importActual) => {
  const actual = await importActual<typeof import('../action-queue')>()
  return {
    ...actual,
    raiseActionQueueItem: raiseSpy,
  }
})

import {
  writeArcQaManifest,
  loadArcQaManifest,
  maybeSuggestPromotion,
  QA_STEP_LIST_PROMOTE_SUGGESTION_SIGNATURE,
  type ArcQaManifest,
} from '../arc-qa-manifest'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh temp directory that acts as the `.mars/` state directory. */
function makeMarsStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'mars-arc-qa-manifest-test-'))
}

/** Canonical minimal manifest for use in tests. */
const makeManifest = (originId: string): ArcQaManifest => ({
  originId,
  generatedAt: 1_700_000_000_000,
  criteria: [
    {
      criterion: 'login form renders',
      steps: [
        { index: 1, text: 'Open the app', screenshotPath: 'step-0.png' },
        { index: 2, text: 'Click Sign in', screenshotPath: null },
      ],
      stoppedAtStep: null,
      stopReason: null,
    },
    {
      criterion: 'error state shown on invalid input',
      steps: [],
      stoppedAtStep: 2,
      stopReason: 'navigation',
    },
  ],
})

// ─────────────────────────────────────────────────────────────────────────────

describe('arc-qa-manifest', () => {
  let marsStateDir: string

  beforeEach(() => {
    marsStateDir = makeMarsStateDir()
  })

  afterEach(() => {
    rmSync(marsStateDir, { recursive: true, force: true })
  })

  // ── loadArcQaManifest: missing file ─────────────────────────────────────────

  describe('loadArcQaManifest()', () => {
    it('returns null when no manifest file exists', async () => {
      const result = await loadArcQaManifest('origin-absent', marsStateDir)
      expect(result).toBeNull()
    })

    it('returns null when the file contains invalid JSON', async () => {
      const dir = join(marsStateDir, 'arc-qa', 'origin-bad-json')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), 'not valid json {{{{')

      const result = await loadArcQaManifest('origin-bad-json', marsStateDir)
      expect(result).toBeNull()
    })

    it('returns null when the JSON is valid but does not match ArcQaManifest shape', async () => {
      const dir = join(marsStateDir, 'arc-qa', 'origin-wrong-shape')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ foo: 'bar' }))

      const result = await loadArcQaManifest('origin-wrong-shape', marsStateDir)
      expect(result).toBeNull()
    })

    it('returns null when originId is missing from the manifest', async () => {
      const dir = join(marsStateDir, 'arc-qa', 'origin-no-id')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({ generatedAt: 123, criteria: [] }),
      )

      const result = await loadArcQaManifest('origin-no-id', marsStateDir)
      expect(result).toBeNull()
    })

    it('returns null when generatedAt is missing from the manifest', async () => {
      const dir = join(marsStateDir, 'arc-qa', 'origin-no-ts')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({ originId: 'origin-no-ts', criteria: [] }),
      )

      const result = await loadArcQaManifest('origin-no-ts', marsStateDir)
      expect(result).toBeNull()
    })
  })

  // ── Round-trip ─────────────────────────────────────────────────────────────

  describe('writeArcQaManifest() + loadArcQaManifest()', () => {
    it('round-trip: loaded manifest equals the written manifest', async () => {
      const originId = 'origin-roundtrip'
      const manifest = makeManifest(originId)

      await writeArcQaManifest(originId, marsStateDir, manifest)
      const loaded = await loadArcQaManifest(originId, marsStateDir)

      expect(loaded).toEqual(manifest)
    })

    it('preserves null screenshotPath on steps', async () => {
      const originId = 'origin-null-screenshot'
      const manifest: ArcQaManifest = {
        originId,
        generatedAt: 9_000_000,
        criteria: [
          {
            criterion: 'foo',
            steps: [{ index: 1, text: 'do something', screenshotPath: null }],
            stoppedAtStep: null,
            stopReason: null,
          },
        ],
      }

      await writeArcQaManifest(originId, marsStateDir, manifest)
      const loaded = await loadArcQaManifest(originId, marsStateDir)

      expect(loaded?.criteria[0].steps[0].screenshotPath).toBeNull()
    })

    it('preserves stoppedAtStep and stopReason', async () => {
      const originId = 'origin-stopped'
      const manifest: ArcQaManifest = {
        originId,
        generatedAt: 1_000,
        criteria: [
          {
            criterion: 'nav',
            steps: [],
            stoppedAtStep: 3,
            stopReason: 'navigation',
          },
        ],
      }

      await writeArcQaManifest(originId, marsStateDir, manifest)
      const loaded = await loadArcQaManifest(originId, marsStateDir)

      expect(loaded?.criteria[0].stoppedAtStep).toBe(3)
      expect(loaded?.criteria[0].stopReason).toBe('navigation')
    })

    it('last write wins when called twice for the same originId', async () => {
      const originId = 'origin-overwrite'
      const first = makeManifest(originId)
      const second: ArcQaManifest = { ...first, generatedAt: 9_999_999 }

      await writeArcQaManifest(originId, marsStateDir, first)
      await writeArcQaManifest(originId, marsStateDir, second)
      const loaded = await loadArcQaManifest(originId, marsStateDir)

      expect(loaded?.generatedAt).toBe(9_999_999)
    })

    it('creates the arc-qa/<originId> directory when it does not exist', async () => {
      const originId = 'origin-mkdir'
      // Do NOT pre-create the directory — writeArcQaManifest must create it.
      await writeArcQaManifest(originId, marsStateDir, makeManifest(originId))

      const loaded = await loadArcQaManifest(originId, marsStateDir)
      expect(loaded).not.toBeNull()
    })
  })

  // ── Path layout ────────────────────────────────────────────────────────────

  describe('path layout', () => {
    it('manifest is written to .mars/arc-qa/<originId>/manifest.json', async () => {
      const originId = 'origin-path-check'
      await writeArcQaManifest(originId, marsStateDir, makeManifest(originId))

      // Load using the exact expected path to confirm the location.
      const { readFile } = await import('node:fs/promises')
      const expectedPath = join(marsStateDir, 'arc-qa', originId, 'manifest.json')
      const raw = await readFile(expectedPath, 'utf-8')
      const parsed = JSON.parse(raw) as ArcQaManifest
      expect(parsed.originId).toBe(originId)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// maybeSuggestPromotion
// ─────────────────────────────────────────────────────────────────────────────

describe('maybeSuggestPromotion()', () => {
  let marsStateDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    marsStateDir = mkdtempSync(join(tmpdir(), 'mars-arc-qa-promote-test-'))
  })

  afterEach(() => {
    rmSync(marsStateDir, { recursive: true, force: true })
  })

  it('QA_STEP_LIST_PROMOTE_SUGGESTION_SIGNATURE is "qa-step-list-promote-suggestion"', () => {
    expect(QA_STEP_LIST_PROMOTE_SUGGESTION_SIGNATURE).toBe('qa-step-list-promote-suggestion')
  })

  it('raises a draft-proposal when the marker is absent', async () => {
    await maybeSuggestPromotion('origin-abc', marsStateDir)

    expect(raiseSpy).toHaveBeenCalledOnce()
    const item = raiseSpy.mock.calls[0][0] as RaiseActionQueueItem
    expect(item.kind).toBe('draft-proposal')
    expect(item.signature).toBe('qa-step-list-promote-suggestion')
  })

  it('writes the .promote-suggested marker after raising the suggestion', async () => {
    await maybeSuggestPromotion('origin-abc', marsStateDir)

    expect(existsSync(join(marsStateDir, 'arc-qa', '.promote-suggested'))).toBe(true)
  })

  it('suggestion body includes the exact mars arc qa <originId> invocation', async () => {
    await maybeSuggestPromotion('origin-myarc', marsStateDir)

    const item = raiseSpy.mock.calls[0][0] as RaiseActionQueueItem
    expect(item.body).toContain('mars arc qa origin-myarc')
  })

  it('does not raise a suggestion when the marker already exists', async () => {
    // Pre-create the marker so the first suggestion is already considered done.
    const markerDir = join(marsStateDir, 'arc-qa')
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(join(markerDir, '.promote-suggested'), '')

    await maybeSuggestPromotion('origin-abc', marsStateDir)

    expect(raiseSpy).not.toHaveBeenCalled()
  })

  it('two sequential arcs: only one suggestion is raised', async () => {
    await maybeSuggestPromotion('origin-first', marsStateDir)
    await maybeSuggestPromotion('origin-second', marsStateDir)

    expect(raiseSpy).toHaveBeenCalledOnce()
  })

  it('marker is at .mars/arc-qa/.promote-suggested (not at marsStateDir root)', async () => {
    await maybeSuggestPromotion('origin-path', marsStateDir)

    // Marker must be inside arc-qa/, not at the marsStateDir root.
    expect(existsSync(join(marsStateDir, 'arc-qa', '.promote-suggested'))).toBe(true)
    expect(existsSync(join(marsStateDir, '.promote-suggested'))).toBe(false)
  })
})
