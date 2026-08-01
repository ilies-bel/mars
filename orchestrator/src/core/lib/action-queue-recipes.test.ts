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
import { ACTION_QUEUE_KINDS } from './action-queue-kinds'
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
  title: 'Test title',
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

  it.each(ACTION_QUEUE_KINDS)('kind "%s" getRecipeVerbs always ends with Dismiss and Snooze', (kind) => {
    const recipe = lookupRecipe(kind)
    const ctx = makeCtx({ kind })
    const verbs = getRecipeVerbs(recipe, ctx)
    expect(verbs.length).toBeGreaterThanOrEqual(2)
    const last = verbs[verbs.length - 1]
    const secondLast = verbs[verbs.length - 2]
    expect(secondLast).toMatchObject({ op: 'dismiss', label: 'Dismiss' })
    expect(last).toMatchObject({ op: 'snooze', label: 'Snooze' })
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
    expect(updated?.snoozedUntil).toBe(futureTs)
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
    expect(found?.snoozedUntil).toBe(pastTs)
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

  it('snoozeActionQueueItem is a no-op for an unknown id', async () => {
    const { snoozeActionQueueItem } = await import('./action-queue')
    // Should not throw
    await expect(
      snoozeActionQueueItem('nonexistent-id-xyz', new Date(Date.now() + 3600_000).toISOString()),
    ).resolves.toBeUndefined()
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

  it('daemon-died has "Restart engine" as primary verb', () => {
    const recipe = lookupRecipe('daemon-died')
    const ctx = makeCtx({ kind: 'daemon-died' })
    const verbs = getRecipeVerbs(recipe, ctx)
    expect(verbs[0]).toMatchObject({ op: 'restart-daemon', style: 'primary' })
  })

  it('failed has "Restart" and "Discard task" verbs', () => {
    const recipe = lookupRecipe('failed')
    const ctx = makeCtx({ kind: 'failed' })
    const verbs = getRecipeVerbs(recipe, ctx)
    const ops = verbs.map((v) => v.op)
    expect(ops).toContain('restart')
    expect(ops).toContain('purge')
  })

  it('awaiting-validation has Validate+merge (primary) and Reject (danger)', () => {
    const recipe = lookupRecipe('awaiting-validation')
    const ctx = makeCtx({ kind: 'awaiting-validation' })
    const verbs = getRecipeVerbs(recipe, ctx)
    const validate = verbs.find((v) => v.op === 'validate')
    const reject = verbs.find((v) => v.op === 'reject')
    expect(validate).toMatchObject({ style: 'primary' })
    expect(reject).toMatchObject({ style: 'danger' })
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
    expect(reject).toMatchObject({ style: 'danger' })
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

  it('scorer-suggested humanSummary uses workflowName from payload', () => {
    const recipe = lookupRecipe('scorer-suggested')
    const ctx = makeCtx({
      kind: 'scorer-suggested',
      payload: { workflowName: 'implement' },
    })
    expect(recipe.humanSummary(ctx)).toContain('implement')
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
  it('daemon-died alert segment first action is restart-daemon with primary style', () => {
    const segment = buildAlertSegment(makeDaemonDiedItem(), 'test-item-id')
    expect(segment.actions[0]).toMatchObject({
      op: 'restart-daemon',
      label: 'Restart engine',
      style: 'primary',
    })
  })

  it('daemon-died alert segment has Dismiss appended after restart-daemon', () => {
    const segment = buildAlertSegment(makeDaemonDiedItem(), 'test-item-id')
    const dismissAction = segment.actions.find((a) => a.op === 'dismiss')
    expect(dismissAction).toBeDefined()
    expect(dismissAction).toMatchObject({ op: 'dismiss', label: 'Dismiss', style: 'default' })
  })

  it('daemon-died alert segment has Snooze appended last', () => {
    const segment = buildAlertSegment(makeDaemonDiedItem(), 'test-item-id')
    const last = segment.actions[segment.actions.length - 1]
    expect(last).toMatchObject({ op: 'snooze', label: 'Snooze', style: 'default' })
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
})
