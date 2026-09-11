/**
 * Tests for the action-queue recipe registry.
 *
 * Three suites:
 *
 *  1. Exhaustiveness — every kind in ACTION_QUEUE_KINDS has a registered
 *     recipe; adding a new kind without a recipe fails this test.
 *
 *  2. Snooze lifecycle — snooze → hidden → reappears when timestamp expires.
 *
 *  3. Compound verb mapping — specific kinds carry the expected primary verbs
 *     and every kind always ends with [Dismiss, Snooze].
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { buildAlertSegment, type RaiseActionQueueItem } from './action-queue'
import { ACTION_QUEUE_KINDS, DERIVED_KINDS } from './action-queue-kinds'
import {
  lookupRecipe,
  getRecipeVerbs,
  registeredKinds,
  type RecipeContext,
} from './action-queue-recipes'

// ── Test helpers ──────────────────────────────────────────────────────────────

const makeCtx = (overrides: Partial<RecipeContext> = {}): RecipeContext => ({
  kind: 'failed',
  entityId: 'test-entity',
  payload: {},
  context: {},
  title: 'Test alert title',
  body: 'Test body',
  raisedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-recipes-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// ── Suite 1: Exhaustiveness ───────────────────────────────────────────────────

describe('action-queue recipe registry — exhaustiveness', () => {
  it('every kind in ACTION_QUEUE_KINDS has a registered recipe', () => {
    const registered = new Set(registeredKinds())
    const missing = ACTION_QUEUE_KINDS.filter((k) => !registered.has(k))
    expect(missing).toEqual([])
  })

  it('registered kind count matches ACTION_QUEUE_KINDS length', () => {
    expect(registeredKinds().length).toBe(ACTION_QUEUE_KINDS.length)
  })

  it.each(ACTION_QUEUE_KINDS)('kind "%s" produces a non-empty humanSummary', (kind) => {
    const recipe = lookupRecipe(kind)
    const ctx = makeCtx({ kind })
    const summary = recipe.humanSummary(ctx)
    expect(typeof summary).toBe('string')
    expect(summary.length).toBeGreaterThan(10)
  })

  it.each(ACTION_QUEUE_KINDS)('kind "%s" humanDetail includes raisedAt', (kind) => {
    const recipe = lookupRecipe(kind)
    const ctx = makeCtx({ kind, raisedAt: '2026-06-01T12:00:00.000Z' })
    const detail = recipe.humanDetail(ctx)
    // humanDetail is an object with at least raisedAt
    expect(typeof detail).toBe('object')
    expect(detail.raisedAt).toBe('2026-06-01T12:00:00.000Z')
  })

  it.each(ACTION_QUEUE_KINDS.filter((k) => !DERIVED_KINDS.has(k)))(
    'stored kind "%s" getRecipeVerbs ends with Snooze (style: snooze)',
    (kind) => {
      const recipe = lookupRecipe(kind)
      const ctx = makeCtx({ kind })
      const verbs = getRecipeVerbs(recipe, ctx)
      expect(verbs.length).toBeGreaterThanOrEqual(1)
      const last = verbs[verbs.length - 1]
      expect(last).toMatchObject({ op: 'snooze', label: 'Snooze', style: 'snooze' })
    },
  )

  it.each(ACTION_QUEUE_KINDS.filter((k) => DERIVED_KINDS.has(k)))(
    'derived kind "%s" getRecipeVerbs does NOT include Snooze',
    (kind) => {
      const recipe = lookupRecipe(kind)
      const ctx = makeCtx({ kind })
      const verbs = getRecipeVerbs(recipe, ctx)
      expect(verbs.every((v) => v.op !== 'snooze')).toBe(true)
    },
  )

  it.each(ACTION_QUEUE_KINDS)('kind "%s" carries the generic dismiss verb only when the daemon can act on it', (kind) => {
    // The daemon's entity handler maps the generic `dismiss` op to proposal
    // dismissal and nothing else; on any other kind the button would 500.
    // `verify-uncovered` is also in GENERIC_DISMISS_KINDS — dismissing a coverage
    // gap is a valid operator resolution (the daemon handler covers this kind).
    const GENERIC_DISMISS_KINDS = new Set(['draft-proposal', 'verify-uncovered'])
    const recipe = lookupRecipe(kind)
    const ctx = makeCtx({ kind })
    const verbs = getRecipeVerbs(recipe, ctx)
    const hasGenericDismiss = verbs.some((v) => v.op === 'dismiss')
    expect(hasGenericDismiss).toBe(GENERIC_DISMISS_KINDS.has(kind))
  })
})

// ── Suite 2: Snooze lifecycle ─────────────────────────────────────────────────

describe('snooze lifecycle', () => {
  let repo: string

  beforeEach(async () => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { initActionQueue } = await import('./action-queue')
    await initActionQueue()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('snoozeActionQueueItem sets snoozedUntil on the item', async () => {
    const { raiseActionQueueItem, getActionQueueItem, snoozeActionQueueItem } =
      await import('./action-queue')

    const id = await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Test task failed',
      body: 'details',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: `test-snooze-lifecycle-${Date.now()}`,
    })

    const futureTs = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await snoozeActionQueueItem(id, futureTs)

    const updated = await getActionQueueItem(id)
    // snoozedUntil is stored/returned as epoch-ms, not the ISO string that
    // was passed in (see the field's doc comment on ActionQueueItem).
    expect(updated?.snoozedUntil).toEqual(expect.any(Number))
    expect(updated?.snoozedUntil).toBe(new Date(futureTs).getTime())
  })

  it('snoozed item is hidden from the open view until expiry', async () => {
    const { raiseActionQueueItem, listActionQueueItems, snoozeActionQueueItem } =
      await import('./action-queue')

    const sig = `test-snooze-hidden-${Date.now()}`
    const id = await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Snooze me',
      body: '',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: sig,
    })

    // Snooze until 1 hour from now
    const futureTs = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await snoozeActionQueueItem(id, futureTs)

    // Simulate the same filter app-services applies: open AND not snoozed
    const now = new Date()
    const allOpen = await listActionQueueItems('open')
    const visible = allOpen.filter(
      (i) =>
        i.snoozedUntil === null || new Date(i.snoozedUntil) <= now,
    )

    const found = visible.find((i) => i.id === id)
    expect(found).toBeUndefined()
  })

  it('snoozed item reappears after the snooze timestamp expires', async () => {
    const { raiseActionQueueItem, listActionQueueItems, snoozeActionQueueItem } =
      await import('./action-queue')

    const sig = `test-snooze-reappear-${Date.now()}`
    const id = await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Snooze expired',
      body: '',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: sig,
    })

    // Snooze until a past timestamp (already expired)
    const pastTs = new Date(Date.now() - 1000).toISOString()
    await snoozeActionQueueItem(id, pastTs)

    // The same filter now should include the item since snoozedUntil <= now
    const now = new Date()
    const allOpen = await listActionQueueItems('open')
    const visible = allOpen.filter(
      (i) =>
        i.snoozedUntil === null || new Date(i.snoozedUntil) <= now,
    )

    const found = visible.find((i) => i.id === id)
    expect(found).toBeDefined()
    // snoozedUntil is stored/returned as epoch-ms, not the ISO string that
    // was passed in (see the field's doc comment on ActionQueueItem).
    expect(found?.snoozedUntil).toEqual(expect.any(Number))
    expect(found?.snoozedUntil).toBe(new Date(pastTs).getTime())
  })

  it('snoozeActionQueueItem rejects an invalid timestamp', async () => {
    const { raiseActionQueueItem, snoozeActionQueueItem } =
      await import('./action-queue')

    const id = await raiseActionQueueItem({
      kind: 'failed',
      category: 'orchestrator',
      priority: 'normal',
      title: 'Invalid snooze',
      body: '',
      payload: {},
      context: {},
      raisedBy: 'test',
      signature: `test-snooze-invalid-${Date.now()}`,
    })

    await expect(
      snoozeActionQueueItem(id, 'not-a-date'),
    ).rejects.toThrow(/Invalid snooze timestamp/)
  })

  it('snoozeActionQueueItem throws for an unknown id (reports failure not success)', async () => {
    const { snoozeActionQueueItem } = await import('./action-queue')
    // A row that does not exist (including all derived condition kinds) must
    // produce a rejection — not a silent 200-with-no-effect.
    await expect(
      snoozeActionQueueItem('nonexistent-id-xyz', new Date(Date.now() + 3600_000).toISOString()),
    ).rejects.toThrow(/not found/)
  })
})

// ── Suite 3: Compound verb mapping ────────────────────────────────────────────

describe('compound verb mapping', () => {
  it('daemon-code-drift has "Restart engine" as primary verb', () => {
    const recipe = lookupRecipe('daemon-code-drift')
    const ctx = makeCtx({ kind: 'daemon-code-drift' })
    const verbs = getRecipeVerbs(recipe, ctx)
    const primary = verbs.find((v) => v.style === 'primary')
    expect(primary).toMatchObject({ op: 'restart-daemon', label: 'Restart engine', style: 'primary' })
  })

  it('daemon-died has "Dismiss" as primary verb (dismiss-daemon-died op)', () => {
    const recipe = lookupRecipe('daemon-died')
    const ctx = makeCtx({ kind: 'daemon-died' })
    const verbs = getRecipeVerbs(recipe, ctx)
    expect(verbs[0]).toMatchObject({ op: 'dismiss-daemon-died', label: 'Dismiss', style: 'primary' })
  })

  it('gate-broken offers a gate-restore primary verb', () => {
    const recipe = lookupRecipe('gate-broken')
    const ctx = makeCtx({ kind: 'gate-broken', payload: { gate: 'gate-abc123' } })
    const verbs = getRecipeVerbs(recipe, ctx)
    const primary = verbs.find((v) => v.style === 'primary')
    expect(primary).toMatchObject({ op: 'gate-restore', label: 'Restore gate' })
  })

  it('every gate-broken verb op is one the daemon actually handles', () => {
    // gate-restore POSTs to /actions/gate-restore/:id — the handler runs the
    // gate's command asynchronously via restoreVerifyGate (app-service).
    // copy hands the operator a pre-filled `mars verify-gate restore <id>` command.
    const recipe = lookupRecipe('gate-broken')
    const ctx = makeCtx({ kind: 'gate-broken', payload: { gate: 'gate-abc123' } })
    const handled = new Set(['gate-restore', 'copy', 'dismiss', 'snooze'])
    for (const verb of getRecipeVerbs(recipe, ctx)) {
      expect(handled).toContain(verb.op)
    }
  })

  it('failed has "Restart" and "Discard task" verbs', () => {
    const recipe = lookupRecipe('failed')
    const ctx = makeCtx({ kind: 'failed' })
    const verbs = getRecipeVerbs(recipe, ctx)
    const ops = verbs.map((v) => v.op)
    expect(ops).toContain('restart')
    expect(ops).toContain('purge')
  })

  it('verify-uncovered has a copy verb pre-filled from proposedGate when present', () => {
    const recipe = lookupRecipe('verify-uncovered')
    const ctx = makeCtx({
      kind: 'verify-uncovered',
      payload: {
        scope: 'orchestrator/src',
        changedPaths: ['orchestrator/src/core/queue.ts'],
        recipe: null,
        proposedGate: {
          name: 'typecheck',
          cmd: 'npx',
          args: ['tsc', '--noEmit'],
          scope: 'orchestrator',
          evidence: 'tsconfig.json',
        },
      },
    })
    const verbs = getRecipeVerbs(recipe, ctx)
    const copyVerb = verbs.find((v) => v.op === 'copy')
    expect(copyVerb).toMatchObject({ label: 'Copy gate command', style: 'primary' })
    expect(copyVerb?.hint).toBe(
      'mars verify-gate add --scope orchestrator --name typecheck --cmd npx -- tsc --noEmit',
    )
  })

  it('verify-uncovered falls back to a minimal scope hint when no proposedGate', () => {
    const recipe = lookupRecipe('verify-uncovered')
    const ctx = makeCtx({
      kind: 'verify-uncovered',
      payload: { scope: 'ui/src', changedPaths: ['ui/src/index.ts'], recipe: null },
    })
    const verbs = getRecipeVerbs(recipe, ctx)
    const copyVerb = verbs.find((v) => v.op === 'copy')
    expect(copyVerb?.hint).toBe('mars verify-gate add --scope ui/src --name <name> --cmd <cmd>')
  })

  it('verify-uncovered auto-appends Dismiss and Snooze (stored row, in GENERIC_DISMISS_KINDS)', () => {
    const recipe = lookupRecipe('verify-uncovered')
    const ctx = makeCtx({
      kind: 'verify-uncovered',
      payload: { scope: 'orchestrator', changedPaths: [], recipe: null },
    })
    const verbs = getRecipeVerbs(recipe, ctx)
    const ops = verbs.map((v) => v.op)
    expect(ops).toContain('dismiss')
    expect(ops).toContain('snooze')
  })

  it('awaiting-validation has Validate+merge (primary) and Reject (danger)', () => {
    const recipe = lookupRecipe('awaiting-validation')
    const ctx = makeCtx({ kind: 'awaiting-validation' })
    const verbs = getRecipeVerbs(recipe, ctx)
    const validate = verbs.find((v) => v.op === 'validate')
    const reject = verbs.find((v) => v.op === 'reject')
    expect(validate).toMatchObject({ style: 'primary' })
    expect(reject).toMatchObject({ style: 'destructive' })
  })

  it('tool-promotion has Promote (primary) and Reject (danger)', () => {
    const recipe = lookupRecipe('tool-promotion')
    const ctx = makeCtx({
      kind: 'tool-promotion',
      payload: { helperKey: 'myHelper' },
    })
    const verbs = getRecipeVerbs(recipe, ctx)
    const promote = verbs.find((v) => v.op === 'approve-tool')
    const reject = verbs.find((v) => v.op === 'reject-tool')
    expect(promote).toMatchObject({ style: 'primary' })
    expect(reject).toMatchObject({ style: 'destructive' })
  })

  it('gate-enrichment has Approve and Retire verbs', () => {
    const recipe = lookupRecipe('gate-enrichment')
    const ctx = makeCtx({ kind: 'gate-enrichment' })
    const verbs = getRecipeVerbs(recipe, ctx)
    expect(verbs.find((v) => v.op === 'enrich-approve')).toBeDefined()
    expect(verbs.find((v) => v.op === 'enrich-retire')).toBeDefined()
  })

  it('provider-rate-limited humanSummary includes resetsAt when present', () => {
    const recipe = lookupRecipe('provider-rate-limited')
    const ctx = makeCtx({
      kind: 'provider-rate-limited',
      payload: { resetsAtIso: '2026-01-01T08:00:00.000Z' },
    })
    expect(recipe.humanSummary(ctx)).toContain('2026-01-01T08:00:00.000Z')
  })

  it('failed humanSummary includes the entity id', () => {
    const recipe = lookupRecipe('failed')
    const ctx = makeCtx({
      kind: 'failed',
      entityId: 'mars-abc123',
      payload: {},
    })
    expect(recipe.humanSummary(ctx)).toContain('mars-abc123')
  })

  it('stale-worktree humanSummary and humanDetail render the age-based payload the derivation actually emits', () => {
    // deriveStaleWorktreeConditions (core/daemon/view/derived-conditions.ts)
    // emits status/prompt/branch/ageHours/updatedAt — this recipe used to
    // read worktree/branch/uncommittedFiles instead, none of which the
    // derivation ever computed, so the alert's detail panel always rendered
    // empty. Assert the recipe reads what the derivation actually produces.
    const recipe = lookupRecipe('stale-worktree')
    const ctx = makeCtx({
      kind: 'stale-worktree',
      entityId: 'mars-abc123',
      payload: {
        status: 'running',
        prompt: 'do the thing',
        branch: 'task/mars-abc123',
        ageHours: 30,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    const summary = recipe.humanSummary(ctx)
    expect(summary).toContain('30h')
    expect(summary).toContain('running')
    expect(summary).toContain('mars-abc123')

    const detail = recipe.humanDetail(ctx)
    expect(detail).toMatchObject({
      status: 'running',
      prompt: 'do the thing',
      branch: 'task/mars-abc123',
      ageHours: 30,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('scorer-suggested humanSummary uses workflow from payload', () => {
    const recipe = lookupRecipe('scorer-suggested')
    const ctx = makeCtx({
      kind: 'scorer-suggested',
      payload: { workflow: 'implement' },
    })
    expect(recipe.humanSummary(ctx)).toContain('implement')
  })
})

// ── Suite 5: failed recipe decision table ─────────────────────────────────────
//
// One test per row of the decision table described in action-queue-recipes.ts.
// Each test asserts the expected primary verb (or absence) AND verifies that
// restart + purge are always appended.

describe('failed recipe — verb decision table', () => {
  const recipe = lookupRecipe('failed')

  // Helper: resolve verbs (the failed recipe's verbs field is a function)
  const verbs = (payload: Record<string, unknown>) =>
    getRecipeVerbs(recipe, makeCtx({ kind: 'failed', entityId: 'mars-abc123', payload }))

  it('recoveryExhausted=false, worktreeExists=true → primary verb is "continue" (Resume on existing worktree)', () => {
    const v = verbs({ recoveryExhausted: false, worktreeExists: true })
    const primary = v.find((x) => x.style === 'primary')
    expect(primary).toMatchObject({ op: 'continue', style: 'primary' })
    expect(primary?.label).toContain('Resume')
  })

  it('recoveryExhausted=false, worktreeExists=true → does NOT emit remerge', () => {
    const v = verbs({ recoveryExhausted: false, worktreeExists: true, realCommitsAhead: 5 })
    expect(v.find((x) => x.op === 'remerge')).toBeUndefined()
  })

  // ── Key discriminating case (was the bug) ────────────────────────────────────
  // Before the fix: worktreeExists was not checked; recoveryExhausted=false
  // always emitted `continue`, even when the worktree was missing on disk.
  // After the fix: worktreeExists=false + realCommitsAhead>0 → remerge, NOT continue.
  it('recoveryExhausted=false, worktreeExists=false, realCommitsAhead=1 → remerge, never continue', () => {
    const v = verbs({ recoveryExhausted: false, worktreeExists: false, realCommitsAhead: 1, checkpointCommitsAhead: 0 })
    const primary = v.find((x) => x.style === 'primary')
    expect(primary).toMatchObject({ op: 'remerge', style: 'primary' })
    expect(v.find((x) => x.op === 'continue')).toBeUndefined()
  })

  it('worktreeExists=null (not probed) → no safe-verb claim: neither continue nor remerge emitted', () => {
    const v = verbs({ recoveryExhausted: false, worktreeExists: null, realCommitsAhead: 1 })
    expect(v.find((x) => x.op === 'continue')).toBeUndefined()
    expect(v.find((x) => x.op === 'remerge')).toBeUndefined()
    // Destructive pair must still be present
    expect(v.find((x) => x.op === 'restart')).toBeDefined()
    expect(v.find((x) => x.op === 'purge')).toBeDefined()
  })

  it('worktreeExists=false, realCommitsAhead=1, recoveryExhausted=true → remerge (same as non-exhausted missing worktree)', () => {
    const v = verbs({ recoveryExhausted: true, worktreeExists: false, realCommitsAhead: 1, checkpointCommitsAhead: 0 })
    const primary = v.find((x) => x.style === 'primary')
    expect(primary).toMatchObject({ op: 'remerge', style: 'primary' })
    expect(v.find((x) => x.op === 'continue')).toBeUndefined()
  })

  it('worktreeExists=false, realCommitsAhead=0, checkpointCommitsAhead=0 → restart only (no safe verb)', () => {
    const v = verbs({ recoveryExhausted: false, worktreeExists: false, realCommitsAhead: 0, checkpointCommitsAhead: 0 })
    expect(v.find((x) => x.op === 'continue')).toBeUndefined()
    expect(v.find((x) => x.op === 'remerge')).toBeUndefined()
    expect(v.find((x) => x.op === 'copy')).toBeUndefined()
    expect(v.find((x) => x.op === 'restart')).toBeDefined()
  })

  it('recoveryExhausted=true, worktreeExists=true, realCommitsAhead=1 → primary verb is "remerge" (NOT continue)', () => {
    const v = verbs({ recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 1, checkpointCommitsAhead: 0 })
    const primary = v.find((x) => x.style === 'primary')
    expect(primary).toMatchObject({ op: 'remerge', style: 'primary' })
    // Must NOT emit continue when recovery is exhausted
    expect(v.find((x) => x.op === 'continue')).toBeUndefined()
  })

  it('recoveryExhausted=true, worktreeExists=true, realCommitsAhead=3 → remerge label names commit count', () => {
    const v = verbs({ recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 3, checkpointCommitsAhead: 0 })
    const remerge = v.find((x) => x.op === 'remerge')
    expect(remerge?.label).toContain('3')
    expect(remerge?.label).toContain('commits')
  })

  it('recoveryExhausted=true, worktreeExists=true, realCommitsAhead=0, checkpointCommitsAhead=2 → copy verb (supersede hint)', () => {
    const v = verbs({
      recoveryExhausted: true,
      worktreeExists: true,
      realCommitsAhead: 0,
      checkpointCommitsAhead: 2,
      taskId: 'mars-abc123',
    })
    const copy = v.find((x) => x.op === 'copy')
    expect(copy).toBeDefined()
    expect(copy?.hint).toContain('--supersede')
    expect(copy?.hint).toContain('mars-abc123')
    // No remerge (no real commits)
    expect(v.find((x) => x.op === 'remerge')).toBeUndefined()
    // No continue (recovery exhausted)
    expect(v.find((x) => x.op === 'continue')).toBeUndefined()
  })

  it('recoveryExhausted=true, worktreeExists=true, realCommitsAhead=0, checkpointCommitsAhead=0 → no primary safe verb (restart is the only forward path)', () => {
    const v = verbs({ recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 0, checkpointCommitsAhead: 0 })
    expect(v.find((x) => x.op === 'continue')).toBeUndefined()
    expect(v.find((x) => x.op === 'remerge')).toBeUndefined()
    expect(v.find((x) => x.op === 'copy')).toBeUndefined()
    // restart should be present as the only forward path
    expect(v.find((x) => x.op === 'restart')).toBeDefined()
  })

  it('worktreeExists=true, realCommitsAhead=null (not probed) → no safe-verb claim emitted', () => {
    const v = verbs({ recoveryExhausted: true, worktreeExists: true, realCommitsAhead: null })
    expect(v.find((x) => x.op === 'continue')).toBeUndefined()
    expect(v.find((x) => x.op === 'remerge')).toBeUndefined()
    expect(v.find((x) => x.op === 'copy')).toBeUndefined()
  })

  it('restart always appended (all decision table rows)', () => {
    const cases = [
      { recoveryExhausted: false, worktreeExists: true },
      { recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 1 },
      { recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 0, checkpointCommitsAhead: 1 },
      { recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 0, checkpointCommitsAhead: 0 },
      { recoveryExhausted: true, worktreeExists: true, realCommitsAhead: null },
      { recoveryExhausted: false, worktreeExists: false, realCommitsAhead: 1 },
      { worktreeExists: null, realCommitsAhead: 1 },
    ] as Record<string, unknown>[]

    for (const payload of cases) {
      const v = verbs(payload)
      expect(v.find((x) => x.op === 'restart'), `restart missing for ${JSON.stringify(payload)}`).toBeDefined()
    }
  })

  it('purge always appended (all decision table rows)', () => {
    const cases = [
      { recoveryExhausted: false, worktreeExists: true },
      { recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 1 },
      { recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 0, checkpointCommitsAhead: 0 },
      { recoveryExhausted: false, worktreeExists: false, realCommitsAhead: 1 },
      { worktreeExists: null },
    ] as Record<string, unknown>[]

    for (const payload of cases) {
      const v = verbs(payload)
      expect(v.find((x) => x.op === 'purge'), `purge missing for ${JSON.stringify(payload)}`).toBeDefined()
    }
  })

  it('restart has needsConfirm:true (never fires without user confirmation)', () => {
    const v = verbs({ recoveryExhausted: false, worktreeExists: true })
    const restart = v.find((x) => x.op === 'restart')
    expect(restart?.needsConfirm).toBe(true)
  })

  it('purge has needsConfirm:true', () => {
    const v = verbs({ recoveryExhausted: false, worktreeExists: true })
    const purge = v.find((x) => x.op === 'purge')
    expect(purge?.needsConfirm).toBe(true)
  })

  it('restart label names commit count when realCommitsAhead > 0 and branch is set', () => {
    const v = verbs({
      recoveryExhausted: true,
      worktreeExists: true,
      realCommitsAhead: 2,
      branch: 'task/mars-abc123',
    })
    const restart = v.find((x) => x.op === 'restart')
    expect(restart?.label).toContain('2')
    expect(restart?.label).toContain('task/mars-abc123')
  })

  it('restart has plain "Restart" label when realCommitsAhead=0', () => {
    const v = verbs({ recoveryExhausted: true, worktreeExists: true, realCommitsAhead: 0, checkpointCommitsAhead: 0 })
    const restart = v.find((x) => x.op === 'restart')
    expect(restart?.label).toBe('Restart')
  })

  it('humanDetail includes realCommitsAhead when probed', () => {
    const detail = recipe.humanDetail(
      makeCtx({ kind: 'failed', payload: { realCommitsAhead: 3, branch: 'task/mars-abc123' } }),
    )
    expect(detail.realCommitsAhead).toBe(3)
  })

  it('humanDetail includes restartConsequence when realCommitsAhead > 0 and branch set', () => {
    const detail = recipe.humanDetail(
      makeCtx({
        kind: 'failed',
        payload: { realCommitsAhead: 2, branch: 'task/mars-abc123' },
      }),
    )
    expect(typeof detail.restartConsequence).toBe('string')
    expect(detail.restartConsequence).toContain('2')
    expect(detail.restartConsequence).toContain('task/mars-abc123')
  })

  it('humanDetail omits restartConsequence when realCommitsAhead=0', () => {
    const detail = recipe.humanDetail(
      makeCtx({ kind: 'failed', payload: { realCommitsAhead: 0, branch: 'task/mars-abc123' } }),
    )
    expect(detail.restartConsequence).toBeUndefined()
  })
})

// ── Suite 4: buildAlertSegment ────────────────────────────────────────────────

const makeDaemonDiedItem = (overrides: Partial<RaiseActionQueueItem> = {}): RaiseActionQueueItem => ({
  kind: 'daemon-died',
  category: 'daemon',
  priority: 'urgent',
  title: 'Background engine crashed',
  body: 'The daemon exited unexpectedly.',
  payload: {},
  context: {},
  raisedBy: 'daemon',
  signature: 'daemon-died:test',
  ...overrides,
})

describe('buildAlertSegment — registered kinds use recipe verbs', () => {
  it('daemon-died alert segment first action is dismiss-daemon-died with primary style', () => {
    const segment = buildAlertSegment(makeDaemonDiedItem(), 'test-item-id')
    expect(segment.actions[0]).toMatchObject({
      op: 'dismiss-daemon-died',
      label: 'Dismiss',
      style: 'primary',
    })
  })

  it('daemon-died alert segment renders exactly one Dismiss (no broken generic dismiss)', () => {
    // The generic `dismiss` op only functions on proposals; on daemon-died it
    // would sit next to the working dismiss-daemon-died with the same label
    // and 500 when clicked.
    const segment = buildAlertSegment(makeDaemonDiedItem(), 'test-item-id')
    expect(segment.actions.find((a) => a.op === 'dismiss')).toBeUndefined()
    expect(segment.actions.filter((a) => a.label === 'Dismiss')).toHaveLength(1)
  })

  it('daemon-died alert segment does NOT include Snooze (derived kind)', () => {
    // daemon-died is a derived condition kind — no stored row, so Snooze is
    // not appended. The segment ends with the kind-specific dismiss verb.
    const segment = buildAlertSegment(makeDaemonDiedItem(), 'test-item-id')
    expect(segment.actions.every((a) => a.op !== 'snooze')).toBe(true)
    // The only action should be the kind-specific dismiss-daemon-died.
    const last = segment.actions[segment.actions.length - 1]
    expect(last).toMatchObject({ op: 'dismiss-daemon-died', label: 'Dismiss' })
  })

  it('awaiting-validation reject verb (danger in recipe) maps to destructive style in segment', () => {
    const item: RaiseActionQueueItem = {
      kind: 'awaiting-validation',
      category: 'orchestrator',
      priority: 'high',
      title: 'Validation needed',
      body: 'Please review.',
      payload: {},
      context: {},
      raisedBy: 'orchestrator',
      signature: 'awaiting-validation:test',
    }
    const segment = buildAlertSegment(item, 'test-item-id')
    const reject = segment.actions.find((a) => a.op === 'reject')
    expect(reject).toBeDefined()
    expect(reject?.style).toBe('destructive')
  })

  it('daemon-died humanSummary is populated from the recipe', () => {
    const segment = buildAlertSegment(makeDaemonDiedItem(), 'test-item-id')
    expect(segment.humanSummary).toBeDefined()
    expect(segment.humanSummary!.length).toBeGreaterThan(10)
  })

  it('daemon-died humanSummary does NOT claim automatic restart', () => {
    // The daemon may have been restarted by the operator, not automatically.
    // Claiming "restarted itself" or "automatically" teaches the wrong lesson.
    const segment = buildAlertSegment(makeDaemonDiedItem(), 'test-item-id')
    const summary = segment.humanSummary ?? ''
    expect(summary).not.toMatch(/restarted itself/i)
    expect(summary).not.toMatch(/automatically/i)
  })

  it('daemon-died humanSummary does not contain a raw ISO timestamp', () => {
    // Raw ISO strings (e.g. 2026-09-11T12:01:29.239Z) are machine text in
    // operator prose. The summary must use a formatted duration instead.
    const segment = buildAlertSegment(
      makeDaemonDiedItem({ payload: { crashDetectedAt: '2026-09-11T12:01:29.239Z' } }),
      'test-item-id',
    )
    const summary = segment.humanSummary ?? ''
    expect(summary).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('daemon-died humanSummary reports downtime when downtimeMs is in the payload', () => {
    // Given a marker with a known downtime, the summary must mention
    // the duration rather than "unknown period".
    const fortyOneMinutesMs = 41 * 60_000
    const segment = buildAlertSegment(
      makeDaemonDiedItem({ payload: { downtimeMs: fortyOneMinutesMs } }),
      'test-item-id',
    )
    const summary = segment.humanSummary ?? ''
    // Should contain a duration mention (e.g. "41 min")
    expect(summary).toMatch(/\d+ min/)
    expect(summary).not.toMatch(/unknown period/i)
  })
})
