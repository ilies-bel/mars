import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface ScorersMod {
  initScorers: typeof import('../scorers').initScorers
  suggestScorer: typeof import('../scorers').suggestScorer
  getScorer: typeof import('../scorers').getScorer
  listScorers: typeof import('../scorers').listScorers
  acceptScorer: typeof import('../scorers').acceptScorer
  dismissScorer: typeof import('../scorers').dismissScorer
  absorbScorerEvidence: typeof import('../scorers').absorbScorerEvidence
  computeScorerFingerprint: typeof import('../scorers').computeScorerFingerprint
  resolveScorerId: typeof import('../scorers').resolveScorerId
  ScorerRecordSchema: typeof import('../scorers').ScorerRecordSchema
  SCORER_OUTPUT_CONTRACT: typeof import('../scorers').SCORER_OUTPUT_CONTRACT
}

interface QueueMod {
  migrateQueueSchema: typeof import('../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../queue').resolveQueueClient
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-scorers-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<{ s: ScorersMod; q: QueueMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const s = (await import('../scorers')) as unknown as ScorersMod
  const q = (await import('../queue')) as unknown as QueueMod
  await s.initScorers()
  await q.migrateQueueSchema()
  return { s, q }
}

const getEvents = async (
  q: QueueMod,
  type: string,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> => {
  const client = q.resolveQueueClient()
  const result = await client.execute({
    sql: `SELECT type, payload FROM events WHERE type = ? ORDER BY id`,
    args: [type],
  })
  return (result.rows as unknown as Array<{ type: string; payload: string }>).map(
    (r) => ({
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }),
  )
}

const baseInput = {
  workflow: 'task',
  title: 'Diff minimality',
  rubric:
    'Given the instance diff, verify output, and transcript digest, grade how tightly the diff is scoped to the stated goal. A 1 means every hunk serves the goal; a 0 means the diff is dominated by unrelated churn.',
  originArcId: 'arc-origin-001',
  reportPath: '/tmp/.mars/deep-reflections/arc-origin-001.json',
  evidence: ['task mars-aaa event 12: Edit landed outside the named files'],
  confidence: 0.8,
} as const

describe('scorers table CRUD + lifecycle', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('suggestScorer inserts a suggested row with the full record shape and emits scorer.suggested', async () => {
    const { s, q } = await loadMods(repo)
    const { scorer, outcome } = await s.suggestScorer({ ...baseInput })
    expect(outcome).toBe('created')
    expect(scorer.status).toBe('suggested')
    expect(scorer.workflow).toBe('task')
    expect(scorer.title).toBe('Diff minimality')
    expect(scorer.outputContract).toBe(s.SCORER_OUTPUT_CONTRACT)
    expect(scorer.originArcId).toBe('arc-origin-001')
    expect(scorer.reportPath).toBe(baseInput.reportPath)
    expect(scorer.evidence).toEqual([...baseInput.evidence])
    expect(scorer.confidence).toBe(0.8)
    expect(scorer.fingerprint).toBe(
      s.computeScorerFingerprint('task', 'Diff minimality'),
    )

    // Read back through the public reader and re-validate against the schema.
    const fetched = await s.getScorer(scorer.id)
    expect(fetched).not.toBeNull()
    expect(() => s.ScorerRecordSchema.parse(fetched)).not.toThrow()
    expect(fetched?.rubric).toBe(baseInput.rubric)

    const events = await getEvents(q, 'scorer.suggested')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({
      scorerId: scorer.id,
      workflow: 'task',
      title: 'Diff minimality',
    })
  })

  it('dedup: re-suggesting the same (workflow, dimension) absorbs into the existing row — no duplicate row, no second event', async () => {
    const { s, q } = await loadMods(repo)
    const first = await s.suggestScorer({ ...baseInput })
    expect(first.outcome).toBe('created')

    const second = await s.suggestScorer({
      ...baseInput,
      // Title differs by case/punctuation only — same fingerprint.
      title: 'diff-MINIMALITY',
      evidence: ['task mars-bbb event 4: unrelated file rewritten'],
      confidence: 0.6,
    })
    expect(second.outcome).toBe('absorbed')
    expect(second.scorer.id).toBe(first.scorer.id)
    // Evidence accrued; confidence keeps the max.
    expect(second.scorer.evidence).toEqual([
      'task mars-aaa event 12: Edit landed outside the named files',
      'task mars-bbb event 4: unrelated file rewritten',
    ])
    expect(second.scorer.confidence).toBe(0.8)

    const all = await s.listScorers()
    expect(all).toHaveLength(1)

    // Exactly one scorer.suggested event — the queue never sees a duplicate.
    const events = await getEvents(q, 'scorer.suggested')
    expect(events).toHaveLength(1)
  })

  it('dedup: different workflow or different dimension produces distinct rows', async () => {
    const { s } = await loadMods(repo)
    await s.suggestScorer({ ...baseInput })
    const otherWorkflow = await s.suggestScorer({ ...baseInput, workflow: 'fix' })
    expect(otherWorkflow.outcome).toBe('created')
    const otherDimension = await s.suggestScorer({
      ...baseInput,
      title: 'Test coverage honesty',
    })
    expect(otherDimension.outcome).toBe('created')
    expect(await s.listScorers()).toHaveLength(3)
  })

  it('accept flips suggested → accepted and emits scorer.accepted; nothing else changes', async () => {
    const { s, q } = await loadMods(repo)
    const { scorer } = await s.suggestScorer({ ...baseInput })

    const accepted = await s.acceptScorer(scorer.id)
    expect(accepted.status).toBe('accepted')
    expect(accepted.rubric).toBe(baseInput.rubric)

    const events = await getEvents(q, 'scorer.accepted')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ scorerId: scorer.id })
  })

  it('dismiss flips suggested → dismissed and emits scorer.dismissed', async () => {
    const { s, q } = await loadMods(repo)
    const { scorer } = await s.suggestScorer({ ...baseInput })

    const dismissed = await s.dismissScorer(scorer.id)
    expect(dismissed.status).toBe('dismissed')

    const events = await getEvents(q, 'scorer.dismissed')
    expect(events).toHaveLength(1)
    expect(events[0].payload).toEqual({ scorerId: scorer.id })
  })

  it('accept/dismiss refuse non-suggested rows (terminal states are final)', async () => {
    const { s } = await loadMods(repo)
    const { scorer } = await s.suggestScorer({ ...baseInput })
    await s.acceptScorer(scorer.id)

    await expect(s.acceptScorer(scorer.id)).rejects.toThrow(
      /is 'accepted'; only suggested scorers/,
    )
    await expect(s.dismissScorer(scorer.id)).rejects.toThrow(
      /is 'accepted'; only suggested scorers/,
    )
  })

  it('re-suggesting an already-triaged dimension is a no-op (already-triaged outcome, no new row, no event)', async () => {
    const { s, q } = await loadMods(repo)
    const { scorer } = await s.suggestScorer({ ...baseInput })
    await s.dismissScorer(scorer.id)

    const again = await s.suggestScorer({ ...baseInput })
    expect(again.outcome).toBe('already-triaged')
    expect(again.scorer.id).toBe(scorer.id)
    expect(await s.listScorers()).toHaveLength(1)
    expect(await getEvents(q, 'scorer.suggested')).toHaveLength(1)
  })

  it('listScorers filters by status and workflow', async () => {
    const { s } = await loadMods(repo)
    const a = await s.suggestScorer({ ...baseInput })
    await s.suggestScorer({ ...baseInput, workflow: 'fix' })
    await s.acceptScorer(a.scorer.id)

    const suggested = await s.listScorers({ status: 'suggested' })
    expect(suggested).toHaveLength(1)
    expect(suggested[0].workflow).toBe('fix')

    const accepted = await s.listScorers({ status: 'accepted' })
    expect(accepted).toHaveLength(1)
    expect(accepted[0].id).toBe(a.scorer.id)

    const taskOnly = await s.listScorers({ workflow: 'task' })
    expect(taskOnly).toHaveLength(1)
    expect(taskOnly[0].id).toBe(a.scorer.id)
  })

  it('resolveScorerId supports unique prefixes and reports ambiguity', async () => {
    const { s } = await loadMods(repo)
    const { scorer } = await s.suggestScorer({ ...baseInput })

    const byPrefix = await s.resolveScorerId(scorer.id.slice(0, 8))
    expect(byPrefix).toEqual({ kind: 'unique', id: scorer.id })

    const none = await s.resolveScorerId('zzzz9999')
    expect(none).toEqual({ kind: 'none' })

    // Too-short prefixes never match.
    const short = await s.resolveScorerId(scorer.id.slice(0, 3))
    expect(short).toEqual({ kind: 'none' })
  })

  it('absorbScorerEvidence appends only to a suggested row matched by fingerprint', async () => {
    const { s } = await loadMods(repo)
    const { scorer } = await s.suggestScorer({ ...baseInput })

    const folded = await s.absorbScorerEvidence(
      'task',
      'Diff Minimality!',
      ['task mars-ccc event 9: verify claimed pass with 0 tests run'],
      0.9,
    )
    expect(folded).not.toBeNull()
    expect(folded?.id).toBe(scorer.id)
    expect(folded?.evidence).toHaveLength(2)
    expect(folded?.confidence).toBe(0.9)

    // No suggested match → null (nothing to fold into).
    const noMatch = await s.absorbScorerEvidence('write', 'Prose tone', ['x'], 0.5)
    expect(noMatch).toBeNull()

    // A triaged row is not absorbed into either.
    await s.acceptScorer(scorer.id)
    const afterTriage = await s.absorbScorerEvidence('task', 'Diff minimality', ['y'], 0.5)
    expect(afterTriage).toBeNull()
  })
})
