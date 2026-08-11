/**
 * stale-worktree-sweep tests (ADR-0057 update).
 *
 * `detectAndRaiseStaleWorktrees` is now a no-op stub: `stale-worktree` rows
 * are derived on read from the filesystem by `deriveStaleWorktreeConditions`
 * in the derivation layer.  This suite verifies the stub's no-op contract
 * and that `buildNextActionBody` (used by the derivation layer) still works.
 */

import { describe, expect, it } from 'vitest'
import {
  detectAndRaiseStaleWorktrees,
  buildNextActionBody,
} from '../stale-worktree-sweep.js'

describe('detectAndRaiseStaleWorktrees (ADR-0057 — derived kind)', () => {
  it('is a no-op that always returns []', async () => {
    const result = await detectAndRaiseStaleWorktrees('/any/repo/root')
    expect(result).toEqual([])
  })
})

describe('buildNextActionBody', () => {
  it('returns a plain description of the stale state', () => {
    const body = buildNextActionBody('mars-abc123', 48, 'queued')
    expect(body).toContain('mars-abc123')
    expect(body).toContain('48h')
    expect(body).toContain('queued')
  })
})
