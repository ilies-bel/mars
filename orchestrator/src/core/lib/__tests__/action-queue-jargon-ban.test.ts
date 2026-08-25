/**
 * Jargon ban for action-queue copy.
 *
 * Scans (a) every kind's humanSummary from the recipe registry and (b) every
 * non-null OPERATIONAL_ALERT_COPY entry's title, body, and optional
 * humanSummary for internal system terms that a non-expert operator should
 * never see.
 *
 * A failing test prints a message like:
 *   Kind "baseline-broken" humanSummary contains banned term "integration branch"
 *
 * This test is expected to fail until PRD b99b1deb slices 3 and 4 have landed
 * and fixed the violations in the recipe/operational-copy renderers.
 */

import { describe, expect, it } from 'vitest'
import { ACTION_QUEUE_KINDS, type ActionQueueKind } from '../action-queue-kinds'
import { lookupRecipe, type RecipeContext } from '../action-queue-recipes'
import {
  OPERATIONAL_ALERT_COPY,
  type PersistedActionQueueRow,
} from '../../daemon/view/action-queue'
import type { DispatchPauseState } from '../../daemon/pause-state'

// ── Banned terms ──────────────────────────────────────────────────────────────

/**
 * Internal jargon that must not appear in operator-facing copy.
 * Each entry is a case-insensitive word-boundary match so:
 *   - "dispatched" is not flagged by the "dispatch" rule
 *   - "subscribers" is not flagged by the "subscriber" rule
 *   - "subscriber-stalled" (kind name) is not considered a sentence match
 */
const BANNED_TERMS: Array<{ term: string; regex: RegExp }> = [
  { term: 'integration branch', regex: /\bintegration branch\b/i },
  { term: 'required gate',      regex: /\brequired gate\b/i },
  // "dispatch" but not "dispatched" / "redispatches" etc.
  { term: 'dispatch',           regex: /\bdispatch\b/i },
  // "baseline" as a standalone word
  { term: 'baseline',           regex: /\bbaseline\b/i },
  { term: 'semaphore',          regex: /\bsemaphore\b/i },
  { term: 'outbox',             regex: /\boutbox\b/i },
  // "subscriber" as a standalone word (not inside "subscription" etc.)
  { term: 'subscriber',         regex: /\bsubscriber\b/i },
]

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * A minimal RecipeContext sufficient to produce realistic output from every
 * kind's humanSummary. Common payload fields are populated; kind-specific
 * fields that would suppress jargon in a fallback path are deliberately left
 * absent so fallback violations are caught.
 */
const makeRecipeCtx = (kind: ActionQueueKind): RecipeContext => ({
  kind,
  entityId: 'test-entity',
  payload: {
    // widely used across many kinds
    taskId: 'test-task-id',
    originTaskId: 'test-origin-id',
    originId: 'test-origin-id',
    failingGateName: 'test-gate',
    gate: 'test-gate',
    signature: 'test-sig',
    verdict: 'test-verdict',
    workflowName: 'test-workflow',
    helperKey: 'test-helper',
    proposalId: 'test-proposal',
    targetKind: 'failed',
    targetId: 'test-target',
    targetVersion: '1',
    conditionKey: 'test-condition',
    message: 'test message',
    missingKinds: ['test-workflow'],
    missing: [],
    arcId: 'test-arc',
    // gate-enrichment requires a stepSpec object
    stepSpec: { cmd: 'npm', args: ['test'], dir: '.' },
    // dirty-integration: populate integrationBranch — the template-literal
    // "integration branch '…'" violation survives even with a real branch,
    // but the value also exercises the non-fallback branch
    integrationBranch: 'test-branch',
    // provider-rate-limited: resetsAtIso exercises the non-empty branch
    resetsAtIso: '2026-08-25T12:00:00.000Z',
    // scheduling-decision
    decision: 'deferred',
    // arc-superseded-on-main
    supersededBySha: 'abc12345',
    // stale-worktree
    ageHours: 48,
    status: 'failed',
    // low-disk-space
    freeBytes: 100 * 1024 * 1024,
  },
  context: {},
  title: 'Test title',
  // body long enough (≥ 20 chars) that awaiting-human escalation uses it
  body: 'Test body for escalation handling — long enough.',
  raisedAt: '2026-01-01T00:00:00.000Z',
})

/** A minimal PersistedActionQueueRow for OPERATIONAL_ALERT_COPY calls. */
const makeRow = (kind: ActionQueueKind): PersistedActionQueueRow => ({
  id: `test-${kind}`,
  kind,
  priority: 'normal',
  title: 'Test title',
  body: 'Test body',
  payload: {
    taskId: 'test-task-id',
    // daemon-died / daemon-outage
    crashDetectedAt: '2026-01-01T00:00:00.000Z',
    outageMs: 60_000,
    strandedTaskCount: 2,
    detectedAt: '2026-01-01T00:00:00.000Z',
    // subscriber-stalled: a <name>:<pid> string so the pid-split branch fires
    subscriberId: 'test-processor:1234',
    // phantom-task
    previousStatus: 'running',
    ageMinutes: 5,
    reason: 'watchdog',
    // gate-broken / baseline-broken
    failingGateName: 'test-gate',
    gate: 'test-gate',
    verdict: 'verify:test/fail',
    streak: 3,
    // stale-queued
    queuedAgeMs: 300_000,
    // low-disk-space
    freeBytes: 100 * 1024 * 1024,
    // fragmented-repo-layout
    workspace: 'test-workspace',
    // signature-storm (escalation branch, stewardAttempts absent → normal branch)
  },
  context: {},
  raisedAt: 1_000_000,
  lastSeenAt: 1_060_000,  // 60 s after raisedAt → "1 min" in subscriber-stalled
})

/** Paused state with reason='baseline' — exercises the baseline-broken path. */
const PAUSED_BASELINE: DispatchPauseState = {
  paused: true,
  reason: 'baseline',
  since: '2026-01-01T00:00:00.000Z',
  detail: null,
}

/** Paused state with reason='storm' — exercises the signature-storm paused path. */
const PAUSED_STORM: DispatchPauseState = {
  paused: true,
  reason: 'storm',
  since: '2026-01-01T00:00:00.000Z',
  detail: null,
}

// ── Helper ────────────────────────────────────────────────────────────────────

const assertNoBannedTerms = (
  kind: ActionQueueKind,
  label: string,
  text: string,
): void => {
  for (const { term, regex } of BANNED_TERMS) {
    expect(
      text,
      `Kind "${kind}" ${label} contains banned term "${term}"`,
    ).not.toMatch(regex)
  }
}

// ── Kinds that have a non-null OPERATIONAL_ALERT_COPY entry ──────────────────

const OPERATIONAL_KINDS = ACTION_QUEUE_KINDS.filter(
  (kind) => OPERATIONAL_ALERT_COPY[kind] !== null,
)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('action-queue copy jargon ban', () => {
  describe('recipe humanSummary', () => {
    it.each([...ACTION_QUEUE_KINDS])(
      'kind "%s" humanSummary contains no banned terms',
      (kind) => {
        const recipe = lookupRecipe(kind)
        const summary = recipe.humanSummary(makeRecipeCtx(kind))
        assertNoBannedTerms(kind, 'humanSummary', summary)
      },
    )
  })

  describe('OPERATIONAL_ALERT_COPY — null pauseState', () => {
    it.each([...OPERATIONAL_KINDS])(
      'kind "%s" title/body contain no banned terms',
      (kind) => {
        const renderer = OPERATIONAL_ALERT_COPY[kind]!
        const { title, body, humanSummary } = renderer(makeRow(kind), null)
        assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY title', title)
        assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY body', body)
        if (humanSummary !== undefined) {
          assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY humanSummary', humanSummary)
        }
      },
    )
  })

  describe('OPERATIONAL_ALERT_COPY — paused pauseState (baseline)', () => {
    it.each([...OPERATIONAL_KINDS])(
      'kind "%s" title/body contain no banned terms',
      (kind) => {
        const renderer = OPERATIONAL_ALERT_COPY[kind]!
        const { title, body, humanSummary } = renderer(makeRow(kind), PAUSED_BASELINE)
        assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY title', title)
        assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY body', body)
        if (humanSummary !== undefined) {
          assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY humanSummary', humanSummary)
        }
      },
    )
  })

  describe('OPERATIONAL_ALERT_COPY — paused pauseState (storm)', () => {
    it.each([...OPERATIONAL_KINDS])(
      'kind "%s" title/body contain no banned terms',
      (kind) => {
        const renderer = OPERATIONAL_ALERT_COPY[kind]!
        const { title, body, humanSummary } = renderer(makeRow(kind), PAUSED_STORM)
        assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY title', title)
        assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY body', body)
        if (humanSummary !== undefined) {
          assertNoBannedTerms(kind, 'OPERATIONAL_ALERT_COPY humanSummary', humanSummary)
        }
      },
    )
  })
})
