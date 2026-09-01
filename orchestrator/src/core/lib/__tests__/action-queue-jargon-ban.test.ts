/**
 * Jargon ban for action-queue copy.
 *
 * Scans (a) every kind's humanSummary from the recipe registry, (b) every
 * non-null OPERATIONAL_ALERT_COPY entry's title, body, and optional
 * humanSummary for internal system terms, and (c) every registered failure
 * kind's failedTaskTitle output for machine-slug shapes.
 *
 * Two enforcement layers:
 *
 *   1. **Banned-word list** — explicit jargon terms a non-expert operator
 *      should never see (e.g. "integration branch", "dispatch", "semaphore").
 *      A failing test prints:
 *        Kind "baseline-broken" humanSummary contains banned term "integration branch"
 *
 *   2. **Slug-shape assertion** — the class of defect the banned-word list
 *      cannot catch: a `family/sub-class` token (lowercase, contains `/`),
 *      which is a machine-internal failure signature shape.
 *      Applied to failedTaskTitle outputs (DEC-18).
 *
 * This test is expected to fail until PRD b99b1deb slices 3 and 4 have landed
 * and fixed the violations in the recipe/operational-copy renderers.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTION_QUEUE_KINDS, type ActionQueueKind } from '../action-queue-kinds'
import { lookupRecipe, type RecipeContext } from '../action-queue-recipes'
import {
  OPERATIONAL_ALERT_COPY,
  type PersistedActionQueueRow,
} from '../../daemon/view/action-queue'
import type { DispatchPauseState } from '../../daemon/pause-state'
import { FAILURE_KINDS, failedTaskTitle } from '../failure-kinds'

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

// ── Slug-shape enforcement (DEC-18) ──────────────────────────────────────────

/**
 * A machine-slug shape: a lowercase token containing a forward slash, matching
 * the `family/sub-class` form of internal failure signatures (e.g.
 * `code/uncommitted-changes`, `verify:typecheck/typecheck-property-not-exist`).
 *
 * This pattern catches the class of defect the banned-word list cannot:
 * `code/uncommitted-changes` is not a listed word, but it IS a slug that
 * must never appear on the face of an operator-facing card.
 *
 * The regex matches any substring of the form `<lower-kebab>/<lower-kebab>`.
 */
const SLUG_SHAPE = /[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*/

describe('failedTaskTitle slug-shape enforcement (DEC-18)', () => {
  it.each(FAILURE_KINDS.map((k) => [k.signature, k] as const))(
    'failedTaskTitle for signature "%s" contains no machine-slug shape',
    (_, kind) => {
      // Test with and without a task id — the slug must not appear in either form.
      const withId = failedTaskTitle({ signature: kind.signature, taskId: 'mars-deadbeef' })
      const withoutId = failedTaskTitle({ signature: kind.signature })
      expect(
        withId,
        `failedTaskTitle(${kind.signature}) [with id] contains a slug shape`,
      ).not.toMatch(SLUG_SHAPE)
      expect(
        withoutId,
        `failedTaskTitle(${kind.signature}) [no id] contains a slug shape`,
      ).not.toMatch(SLUG_SHAPE)
    },
  )

  it('a bare kind name drawn from ACTION_QUEUE_KINDS does not appear in humanSummary output', () => {
    // Derived-condition rows whose entityId IS the kind slug (e.g. daemon-code-drift)
    // must not have that slug bleed into the humanSummary the operator reads first.
    for (const kind of ACTION_QUEUE_KINDS) {
      const recipe = lookupRecipe(kind)
      const summary = recipe.humanSummary(makeRecipeCtx(kind))
      // A bare kind slug in humanSummary would be a machine name on the face.
      // Allow the kind slug only when it is part of a natural English word
      // (e.g. "failed" is both a kind and a common English word — allow it).
      // The assertion targets multi-word kebab slugs (contain a hyphen).
      if (kind.includes('-')) {
        expect(
          summary,
          `Kind "${kind}" humanSummary contains the bare kind slug "${kind}"`,
        ).not.toContain(kind)
      }
    }
  })
})

// ── taskFailureKinds drift gate (ACTION_QUEUE_KINDS side) ─────────────────────
//
// ACTION_QUEUE_KINDS (action-queue-kinds.ts) is one half of the complement the
// daemon uses to classify task-failure kinds. The UI mirror `taskFailureKinds`
// (ui/src/shared/schemas.ts) must equal ACTION_QUEUE_KINDS minus
// NON_TASK_FAILURE_KINDS at all times.
//
// This gate runs from the test file most naturally scoped to action-queue-kinds.ts
// (this file already imports ACTION_QUEUE_KINDS) so a verify command covering
// ACTION_QUEUE_KINDS changes also catches UI mirror drift without the task author
// needing to widen --verify.
//
// The authoritative UI-side gate: ui/src/shared/taskFailureKinds.driftGate.test.ts
// The NON_TASK_FAILURE_KINDS-side gate: orchestrator/src/core/daemon/view/action-queue.test.ts

function extractQuotedList(source: string, pattern: RegExp): string[] {
  const match = pattern.exec(source)
  if (!match) {
    throw new Error(`could not locate array literal matching ${pattern} in source`)
  }
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

describe('taskFailureKinds drift gate — ACTION_QUEUE_KINDS side', () => {
  it('ui taskFailureKinds matches ACTION_QUEUE_KINDS minus NON_TASK_FAILURE_KINDS exactly', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))

    const aqSource = readFileSync(
      path.resolve(here, '../../daemon/view/action-queue.ts'),
      'utf8',
    )
    const nonTaskKinds = extractQuotedList(
      aqSource,
      /const NON_TASK_FAILURE_KINDS = new Set\(\[([\s\S]*?)\]\)/,
    )
    expect(
      nonTaskKinds.length,
      'NON_TASK_FAILURE_KINDS extraction returned empty — check regex against action-queue.ts',
    ).toBeGreaterThan(0)

    const uiSource = readFileSync(
      path.resolve(here, '../../../../../ui/src/shared/schemas.ts'),
      'utf8',
    )
    const uiKinds = extractQuotedList(
      uiSource,
      /export const taskFailureKinds = \[([\s\S]*?)\] as const/,
    )
    expect(
      uiKinds.length,
      'taskFailureKinds extraction returned empty — check regex against ui/src/shared/schemas.ts',
    ).toBeGreaterThan(0)

    const nonTaskSet = new Set(nonTaskKinds)
    const expected = Array.from(ACTION_QUEUE_KINDS).filter((k) => !nonTaskSet.has(k))

    expect([...uiKinds].sort()).toEqual([...expected].sort())
  })

  it('extraction guard — throws on syntax change, not silently empty', () => {
    expect(() =>
      extractQuotedList(
        'export const ACTION_QUEUE_KINDS = new Set([])',
        /export const ACTION_QUEUE_KINDS = \[([\s\S]*?)\] as const/,
      ),
    ).toThrow('could not locate array literal')
  })
})
