/**
 * Payload/recipe join contract for stored action-queue kinds.
 *
 * ## The defect class this closes
 *
 * A recipe reads payload keys by string name; a raiser writes them by string
 * name; nothing used to check the two agree. When they drifted the row still
 * rendered — with a blank detail panel, and (for `awaiting-human`) a summary
 * that contradicted its own title.
 *
 * Found three times: `failed`, then `daemon-code-drift`, then `awaiting-human`
 * + `gate-enrichment`. The primary guard is now the **type system** —
 * `action-queue-payloads.ts` declares each audited kind's payload, the raiser
 * is checked against it by `raiseActionQueueItem`, and the recipe receives it
 * as `ctx.payload`. A recipe reading a key no raiser emits does not compile.
 *
 * This file is the behavioural half of that guard. It exists because a type
 * cannot assert that a rendered panel is non-*empty*: `stepSpec` was a case
 * where the key name was reachable but the value was an object, so `str()`
 * rendered `''` and the operator still saw nothing. Types pin the names;
 * these tests pin the output.
 */
import { describe, expect, it } from 'vitest'
import {
  ACTION_QUEUE_KINDS,
  type ActionQueueKind,
} from '../action-queue-kinds'
import {
  ACTION_QUEUE_PAYLOAD_AUDIT,
  awaitingHumanSituation,
  type AwaitingHumanPayload,
  type GateEnrichmentPayload,
} from '../action-queue-payloads'
import { lookupRecipe, type RecipeContext } from '../action-queue-recipes'

const RAISED_AT = '2026-08-20T09:00:00.000Z'

const ctxFor = <K extends ActionQueueKind>(
  kind: K,
  payload: RecipeContext<K>['payload'],
  over: Partial<RecipeContext<K>> = {},
): RecipeContext<K> => ({
  kind,
  entityId: 'aq-1',
  payload,
  context: {},
  title: 'title',
  body: 'body',
  raisedAt: RAISED_AT,
  ...over,
})

/** Fields a rendered detail panel must carry beyond the boilerplate. */
const substantiveFields = (detail: Record<string, unknown>): string[] =>
  Object.entries(detail)
    .filter(([k, v]) =>
      k !== 'raisedAt' && k !== 'entityId' &&
      v !== '' && v !== null && v !== undefined)
    .map(([k]) => k)

// ── awaiting-human ────────────────────────────────────────────────────────────

describe('awaiting-human renders the situation that raised it', () => {
  /** Mirrors the payload raised by `tools/human/await-human.ts`. */
  const leasePark: AwaitingHumanPayload = {
    situation: 'lease-park',
    taskId: 'mars-7f2de34d',
    leaseOwner: 'workflow:await-human',
    leasedAt: '2026-08-19T18:21:13.001Z',
    leaseNote: 'Implement the task in this worktree.',
    stepName: 'code',
  }

  /** Mirrors the payload raised by `daemon/phantom-task-watchdog.ts`. */
  const leaseExpired: AwaitingHumanPayload = {
    situation: 'lease-expired',
    taskId: 'mars-6340b827',
    leaseOwner: 'operator',
    leasedAt: '2026-08-18T02:00:00.000Z',
    leaseNote: null,
    ageMinutes: 940,
  }

  /**
   * The row observed on 2026-08-20 — an agent escalating through
   * `mars action-queue raise`. Its payload was literally `{}`, and the recipe
   * answered with the lease sentence, which had nothing to do with it.
   */
  const spuriousRecovery = {
    title: 'Spurious recovery fix-d612292d: arc mars-fa515ea9 already done',
    body:
      'Recovery fix-d612292d was spawned for arc mars-fa515ea9, which had already reached done. ' +
      'Nothing to recover. Drop the recovery task.',
  }

  it('lease-park: detail carries the lease fields and the step', () => {
    const recipe = lookupRecipe('awaiting-human')
    const ctx = ctxFor('awaiting-human', leasePark)
    const detail = recipe.humanDetail(ctx)

    expect(detail.situation).toBe('lease-park')
    expect(detail.taskId).toBe('mars-7f2de34d')
    expect(detail.leaseOwner).toBe('workflow:await-human')
    expect(detail.leasedAt).toBe('2026-08-19T18:21:13.001Z')
    expect(detail.leaseNote).toBe('Implement the task in this worktree.')
    expect(detail.stepName).toBe('code')
    // The two keys the old recipe read, which no raiser has ever emitted.
    expect(detail).not.toHaveProperty('note')
    expect(detail).not.toHaveProperty('branch')

    expect(recipe.humanSummary(ctx)).toContain('working interactively')
  })

  it('lease-expired: says the lease is idle, not that someone is working', () => {
    const recipe = lookupRecipe('awaiting-human')
    const ctx = ctxFor('awaiting-human', leaseExpired)
    const summary = recipe.humanSummary(ctx)

    expect(summary).toContain('940 min')
    expect(summary).toContain('nobody is working')
    expect(summary).not.toContain('working interactively')

    const detail = recipe.humanDetail(ctx)
    expect(detail.situation).toBe('lease-expired')
    expect(detail.ageMinutes).toBe(940)
  })

  it('spurious recovery: summary matches the escalation, not the lease text', () => {
    const recipe = lookupRecipe('awaiting-human')
    const ctx = ctxFor('awaiting-human', { situation: 'escalation' }, spuriousRecovery)

    const summary = recipe.humanSummary(ctx)
    // The regression: this row used to read
    // "<someone> is working interactively on a task — it will resume
    //  automatically when the lease is released", flatly contradicting a title
    // about a recovery on an arc that was already done.
    expect(summary).not.toContain('working interactively')
    expect(summary).not.toContain('lease is released')
    expect(summary).toContain('already reached done')

    const detail = recipe.humanDetail(ctx)
    expect(detail.situation).toBe('escalation')
    expect(detail.note).toContain('Nothing to recover')
    expect(substantiveFields(detail as Record<string, unknown>).length).toBeGreaterThan(0)
  })

  it('escalation: surfaces the agent-authored payload fields', () => {
    const recipe = lookupRecipe('awaiting-human')
    // The second live row observed on 2026-08-20.
    const detail = recipe.humanDetail(ctxFor('awaiting-human', {
      situation: 'escalation',
      recovery_task: 'fix-fc05f779',
      rescue_operator_task: 'mars-a6f6fd91',
      origin_task: 'mars-2eb61bfd',
      origin_status: 'done',
    }))

    expect(detail.recovery_task).toBe('fix-fc05f779')
    expect(detail.origin_task).toBe('mars-2eb61bfd')
    expect(detail.origin_status).toBe('done')
    // The occurrence trail is bookkeeping, not operator-facing content.
    expect(detail).not.toHaveProperty('occurrences')
  })

  it('infers the situation for rows raised before the discriminator existed', () => {
    // Every row already in the database predates `situation`. They must not
    // all collapse into the escalation branch.
    expect(awaitingHumanSituation(
      { taskId: 't', leaseOwner: 'alice', leasedAt: 'x', leaseNote: null } as never,
    )).toBe('lease-park')
    expect(awaitingHumanSituation(
      { taskId: 't', leaseOwner: 'alice', leasedAt: 'x', leaseNote: null, ageMinutes: 90 } as never,
    )).toBe('lease-expired')
    expect(awaitingHumanSituation({} as never)).toBe('escalation')
  })
})

// ── gate-enrichment ───────────────────────────────────────────────────────────

describe('gate-enrichment shows the candidate check it asks about', () => {
  /** Mirrors the payload raised by `lib/gate-enrichment.ts`. */
  const payload: GateEnrichmentPayload = {
    signature: 'verify:build/typecheck-error',
    encodableFamily: 'command',
    originTaskId: 'mars-80827dbe',
    failingStep: 'verify:build',
    writerTaskId: 'mars-ac883bbf',
    stepSpec: {
      name: 'enrich:verify:build/typecheck-error',
      cmd: 'npm',
      args: ['run', 'build'],
      required: true,
      dir: 'ui',
      tier: 'task',
    },
  }

  it('renders the candidate command, not an empty string', () => {
    const detail = lookupRecipe('gate-enrichment')
      .humanDetail(ctxFor('gate-enrichment', payload))

    // The bug: `candidateCheck` was read from a key nothing emitted, and the
    // value that *does* exist is an object — so `str()` produced ''. The row
    // asked the operator to approve or retire a check it never showed them.
    expect(detail.candidateCheck).toBe('npm run build (dir: ui)')
    expect(detail.signature).toBe('verify:build/typecheck-error')
    expect(detail.failingStep).toBe('verify:build')
    expect(detail.originTaskId).toBe('mars-80827dbe')
    expect(detail.writerTaskId).toBe('mars-ac883bbf')
    // Lived on the row's `seen_count` column, never in payload.
    expect(detail).not.toHaveProperty('seenCount')
  })

  it('summary names the command so the decision is answerable from the list', () => {
    const summary = lookupRecipe('gate-enrichment')
      .humanSummary(ctxFor('gate-enrichment', payload))
    expect(summary).toContain('npm run build')
  })

  it('says so explicitly when no runnable check could be encoded', () => {
    const detail = lookupRecipe('gate-enrichment')
      .humanDetail(ctxFor('gate-enrichment', { ...payload, stepSpec: null }))
    expect(detail.candidateCheck).toContain('none')
  })
})

// ── The class-closing check ───────────────────────────────────────────────────

describe('payload/recipe join is checkable for every kind', () => {
  it('classifies every action-queue kind', () => {
    // ACTION_QUEUE_PAYLOAD_AUDIT is total over ActionQueueKind via `satisfies`,
    // so a new kind is a compile error until it is classified. This asserts
    // the runtime shape agrees, and documents the remaining unaudited surface.
    for (const kind of ACTION_QUEUE_KINDS) {
      expect(ACTION_QUEUE_PAYLOAD_AUDIT[kind]).toBeDefined()
    }
    expect(Object.keys(ACTION_QUEUE_PAYLOAD_AUDIT).sort())
      .toEqual([...ACTION_QUEUE_KINDS].sort())
  })

  it('typed kinds read only keys their contract declares', () => {
    // Types already forbid reading an undeclared key. This catches the other
    // half — reading a *declared* key that the representative payload does not
    // actually carry a usable value for.
    const representative: {
      [K in 'awaiting-human' | 'gate-enrichment']: RecipeContext<K>['payload']
    } = {
      'awaiting-human': {
        situation: 'lease-park',
        taskId: 'mars-1',
        leaseOwner: 'alice',
        leasedAt: RAISED_AT,
        leaseNote: 'note',
        stepName: 'code',
      },
      'gate-enrichment': {
        signature: 'sig',
        encodableFamily: 'command',
        originTaskId: 'mars-2',
        failingStep: 'verify:build',
        writerTaskId: 'mars-3',
        stepSpec: { name: 'n', cmd: 'npm', args: ['test'], required: true },
      },
    }

    const typedKinds = ACTION_QUEUE_KINDS.filter(
      (k) => ACTION_QUEUE_PAYLOAD_AUDIT[k] === 'typed',
    )
    expect(typedKinds.sort()).toEqual(['awaiting-human', 'gate-enrichment'])

    for (const kind of typedKinds as ('awaiting-human' | 'gate-enrichment')[]) {
      const payload = representative[kind]
      const read: string[] = []
      const probe = new Proxy(payload as Record<string, unknown>, {
        get(target, prop) {
          if (typeof prop === 'string') read.push(prop)
          return Reflect.get(target, prop)
        },
      })

      const recipe = lookupRecipe(kind)
      const ctx = ctxFor(kind, probe as never)
      const detail = recipe.humanDetail(ctx)
      recipe.humanSummary(ctx)

      const missing = read.filter(
        (key) => !(key in (payload as object)) && key !== 'occurrences',
      )
      expect(missing, `${kind}: recipe read keys absent from its payload`).toEqual([])
      expect(
        substantiveFields(detail as Record<string, unknown>).length,
        `${kind}: detail panel rendered no content`,
      ).toBeGreaterThan(0)
    }
  })

  it('every kind renders a non-empty summary from an empty payload', () => {
    // A row with a payload the recipe cannot use must still say something.
    for (const kind of ACTION_QUEUE_KINDS) {
      const summary = lookupRecipe(kind).humanSummary({
        kind,
        entityId: 'aq-1',
        payload: {},
        context: {},
        title: 'title',
        body: 'body',
        raisedAt: RAISED_AT,
      })
      expect(summary.trim(), `${kind} rendered an empty summary`).not.toBe('')
    }
  })
})
