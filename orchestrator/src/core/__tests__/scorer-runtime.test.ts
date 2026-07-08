/**
 * Scorer runtime acceptance tests (PRD 6cf85bc9, run half).
 *
 * Contract under test (ADR "Scorers are record-only quality signal, not a
 * merge gate"):
 *   1. a completed instance of a scorer's target workflow IS scored and the
 *      result recorded (+ a scorer_result trace event referencing the row)
 *   2. a completed instance of a NON-target workflow is NOT scored
 *   3. a LOW score never changes the task's status and never spawns recovery
 *   4. the kill-switch (MARS_SCORING_DISABLED / MARS_REFLECT_DISABLED) skips
 *      the run entirely
 *   5. a judge failure records an `error` row and stops — no retry, no task
 *      mutation
 *   6. one run per (Scorer, instance) — a duplicate delivery is skipped
 *
 * Plus: the scoring pool's dedupe/cap discipline and the off-by-default
 * low-trend trigger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { TraceEventInput, TraceEventStore } from '../lib/trace-events-store'

type QueueMod = typeof import('../queue')
type ScorersMod = typeof import('../scorers')
type ScorerResultsMod = typeof import('../scorer-results')
type ScorerRuntimeMod = typeof import('../lib/scorer-runtime')

interface Mods {
  q: QueueMod
  s: ScorersMod
  sr: ScorerResultsMod
  rt: ScorerRuntimeMod
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-scorer-runtime-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (repo: string): Promise<Mods> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = await import('../queue')
  await q.migrateQueueSchema()
  const s = await import('../scorers')
  await s.initScorers()
  const sr = await import('../scorer-results')
  await sr.initScorerResults()
  const rt = await import('../lib/scorer-runtime')
  return { q, s, sr, rt }
}

/** Create a task row and force it into the given status. */
const makeTask = async (
  m: Mods,
  status: string,
  prompt = 'implement the thing',
): Promise<string> => {
  const task = await m.q.enqueueTask(prompt)
  await m.q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET status = ? WHERE id = ?`,
    args: [status, task.id],
  })
  return task.id
}

/** Suggest + accept a Scorer for the given workflow kind. */
const makeAcceptedScorer = async (
  m: Mods,
  workflow: string,
  title = 'Diff minimality',
): Promise<string> => {
  const { scorer } = await m.s.suggestScorer({
    workflow,
    title,
    rubric:
      'Grade how tightly the diff is scoped to the stated goal on a 0..1 scale.',
    originArcId: 'arc-1',
    reportPath: null,
    evidence: ['evidence line'],
    confidence: 0.9,
  })
  await m.s.acceptScorer(scorer.id)
  return scorer.id
}

/** In-memory TraceEventStore capturing recorded events. */
const makeTraceStore = (): { store: TraceEventStore; events: TraceEventInput[] } => {
  const events: TraceEventInput[] = []
  const store = {
    record: async (event: TraceEventInput): Promise<void> => {
      events.push(event)
    },
    query: async () => [],
    close: async () => {},
  } as unknown as TraceEventStore
  return { store, events }
}

describe('runScorersForTask', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_SCORING_DISABLED
    delete process.env.MARS_REFLECT_DISABLED
    rmSync(repo, { recursive: true, force: true })
  })

  it('scores a completed instance of the target workflow and records the result + trace event', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'done')
    const scorerId = await makeAcceptedScorer(m, 'task')
    const { store, events } = makeTraceStore()
    const judge = vi.fn(async () => ({
      score: 0.42,
      rationale: 'adequate but verbose diff',
    }))

    const outcome = await m.rt.runScorersForTask(taskId, {
      judge,
      traceStore: store,
    })

    expect(outcome.outcome).toBe('ran')
    expect(outcome.workflow).toBe('task')
    expect(outcome.scored).toBe(1)
    expect(outcome.errored).toBe(0)
    expect(judge).toHaveBeenCalledTimes(1)

    const row = await m.sr.getScorerResult(scorerId, taskId)
    expect(row).not.toBeNull()
    expect(row?.score).toBe(0.42)
    expect(row?.rationale).toBe('adequate but verbose diff')
    expect(row?.status).toBe('scored')

    const traceEvents = events.filter((e) => e.kind === 'scorer_result')
    expect(traceEvents).toHaveLength(1)
    expect(traceEvents[0].taskId).toBe(taskId)
    expect(traceEvents[0].payload).toMatchObject({
      scorerId,
      workflow: 'task',
      score: 0.42,
      status: 'scored',
      resultId: row?.id,
    })
  })

  it('does NOT score an instance of a non-target workflow', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'done')
    // Scorer targets a different workflow kind than the instance's.
    await makeAcceptedScorer(m, 'refactor-pipeline')
    const judge = vi.fn(async () => ({ score: 1, rationale: 'never called' }))

    const outcome = await m.rt.runScorersForTask(taskId, { judge })

    expect(outcome.outcome).toBe('no-scorers')
    expect(judge).not.toHaveBeenCalled()
    expect(await m.sr.listScorerResults()).toHaveLength(0)
  })

  it('does NOT run a suggested (un-accepted) scorer', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'done')
    await m.s.suggestScorer({
      workflow: 'task',
      title: 'Still suggested',
      rubric: 'rubric text long enough',
      originArcId: 'arc-1',
      reportPath: null,
      evidence: [],
      confidence: 0.5,
    })
    const judge = vi.fn(async () => ({ score: 1, rationale: 'never called' }))
    const outcome = await m.rt.runScorersForTask(taskId, { judge })
    expect(outcome.outcome).toBe('no-scorers')
    expect(judge).not.toHaveBeenCalled()
  })

  it('a LOW score never changes task status and never spawns recovery', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'done')
    await makeAcceptedScorer(m, 'task')
    const judge = vi.fn(async () => ({
      score: 0.02,
      rationale: 'barely related to the goal',
    }))

    const outcome = await m.rt.runScorersForTask(taskId, { judge })
    expect(outcome.scored).toBe(1)

    // Status untouched — verify remains the sole gate.
    const task = await m.q.getTask(taskId)
    expect(task?.status).toBe('done')

    // No recovery: exactly one task row, none pointing at the origin.
    const c = m.q.resolveQueueClient()
    const taskCount = await c.execute(`SELECT COUNT(*) AS n FROM tasks`)
    expect(Number((taskCount.rows[0] as unknown as { n: number }).n)).toBe(1)
    const fixCount = await c.execute(
      `SELECT COUNT(*) AS n FROM tasks WHERE fix_for_task_id IS NOT NULL`,
    )
    expect(Number((fixCount.rows[0] as unknown as { n: number }).n)).toBe(0)
  })

  it('skips the run when the scoring kill-switch is off', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'done')
    await makeAcceptedScorer(m, 'task')
    const judge = vi.fn(async () => ({ score: 1, rationale: 'never called' }))

    process.env.MARS_SCORING_DISABLED = '1'
    const outcome = await m.rt.runScorersForTask(taskId, { judge })
    expect(outcome.outcome).toBe('disabled')
    expect(judge).not.toHaveBeenCalled()
    expect(await m.sr.listScorerResults()).toHaveLength(0)

    // MARS_REFLECT_DISABLED is the comprehensive signal-capture disable and
    // must also stop scoring.
    delete process.env.MARS_SCORING_DISABLED
    process.env.MARS_REFLECT_DISABLED = '1'
    const outcome2 = await m.rt.runScorersForTask(taskId, { judge })
    expect(outcome2.outcome).toBe('disabled')
    expect(judge).not.toHaveBeenCalled()
  })

  it('does not score non-done instances', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'failed')
    await makeAcceptedScorer(m, 'task')
    const judge = vi.fn(async () => ({ score: 1, rationale: 'never called' }))
    const outcome = await m.rt.runScorersForTask(taskId, { judge })
    expect(outcome.outcome).toBe('not-done')
    expect(judge).not.toHaveBeenCalled()
  })

  it('a judge failure records an error row, leaves the task untouched, and does not throw', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'done')
    const scorerId = await makeAcceptedScorer(m, 'task')
    const { store, events } = makeTraceStore()
    const judge = vi.fn(async () => {
      throw new Error('scorer worker exited 1')
    })

    const outcome = await m.rt.runScorersForTask(taskId, {
      judge,
      traceStore: store,
    })
    expect(outcome.errored).toBe(1)
    expect(outcome.scored).toBe(0)

    const row = await m.sr.getScorerResult(scorerId, taskId)
    expect(row?.status).toBe('error')
    expect(row?.score).toBeNull()
    expect(row?.rationale).toContain('scorer worker exited 1')

    const task = await m.q.getTask(taskId)
    expect(task?.status).toBe('done')

    const errEvents = events.filter((e) => e.kind === 'scorer_result')
    expect(errEvents).toHaveLength(1)
    expect(errEvents[0].payload).toMatchObject({ status: 'error' })
  })

  it('runs each accepted scorer once per instance — a duplicate delivery is skipped', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'done')
    await makeAcceptedScorer(m, 'task')
    const judge = vi.fn(async () => ({ score: 0.8, rationale: 'good' }))

    const first = await m.rt.runScorersForTask(taskId, { judge })
    const second = await m.rt.runScorersForTask(taskId, { judge })

    expect(first.scored).toBe(1)
    expect(second.scored).toBe(0)
    expect(second.skipped).toBe(1)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(await m.sr.listScorerResults({ taskId })).toHaveLength(1)
  })

  it('effectiveWorkflowKind: explicit task.workflow wins over kind', async () => {
    const m = await loadMods(repo)
    expect(
      m.rt.effectiveWorkflowKind({ workflow: 'custom-flow', kind: 'task' }),
    ).toBe('custom-flow')
    expect(m.rt.effectiveWorkflowKind({ workflow: null, kind: 'fix' })).toBe('fix')
    expect(m.rt.effectiveWorkflowKind({ workflow: null })).toBe('task')
  })

  it('rejects an out-of-contract judge verdict as an error row', async () => {
    const m = await loadMods(repo)
    const taskId = await makeTask(m, 'done')
    const scorerId = await makeAcceptedScorer(m, 'task')
    // Score outside 0..1 violates the output contract.
    const judge = vi.fn(async () => ({ score: 7, rationale: 'inflated' }))
    const outcome = await m.rt.runScorersForTask(taskId, { judge })
    expect(outcome.errored).toBe(1)
    const row = await m.sr.getScorerResult(scorerId, taskId)
    expect(row?.status).toBe('error')
  })
})

describe('scoring pool', () => {
  it('dedupes pending ids and never exceeds its cap', async () => {
    const { createScoringPool } = await import('../daemon/scoring-pool')
    let running = 0
    let maxRunning = 0
    const seen: string[] = []
    const pool = createScoringPool({
      limit: 1,
      log: () => {},
      runScoring: async (taskId) => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        seen.push(taskId)
        await new Promise((r) => setTimeout(r, 5))
        running -= 1
      },
    })
    pool.enqueue('a')
    pool.enqueue('a') // duplicate absorbed
    pool.enqueue('b')
    pool.enqueue('c')
    await pool.onIdle()
    expect(maxRunning).toBe(1)
    expect(seen.sort()).toEqual(['a', 'b', 'c'])
  })

  it('a throwing scoring run is logged and never escapes', async () => {
    const { createScoringPool } = await import('../daemon/scoring-pool')
    const logs: string[] = []
    const pool = createScoringPool({
      limit: 2,
      log: (msg) => logs.push(msg),
      runScoring: async () => {
        throw new Error('boom')
      },
    })
    pool.enqueue('x')
    await pool.onIdle()
    expect(logs.some((l) => l.includes('boom'))).toBe(true)
  })
})

describe('low-trend trigger (off by default, operator opt-in)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const insertLowScores = async (m: Mods, n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      await m.sr.recordScorerResult({
        scorerId: `sc-${i}`,
        taskId: `t-${i}`,
        workflow: 'task',
        score: 0.1,
        rationale: 'low',
        status: 'scored',
      })
    }
  }

  it('raises nothing while scoring.autoTrigger is off (the default)', async () => {
    const m = await loadMods(repo)
    await insertLowScores(m, 5)
    const { runScorerLowTrendTrigger } = await import('../lib/scorer-trend-trigger')
    const result = await runScorerLowTrendTrigger()
    expect(result.raised).toHaveLength(0)
  })

  it('with opt-in ON, a sustained low median raises ONE deduped reflection draft', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({
        scoring: { autoTrigger: true, lowTrendThreshold: 0.5, lowTrendWindow: 5 },
      }),
      'utf8',
    )
    const m = await loadMods(repo)
    await insertLowScores(m, 5)
    const { runScorerLowTrendTrigger, scorerTrendKpiTag } = await import(
      '../lib/scorer-trend-trigger'
    )
    const first = await runScorerLowTrendTrigger()
    expect(first.raised).toHaveLength(1)

    const { getProposal, findOpenDraftByKpiTag } = await import('../proposals')
    const proposal = await getProposal(first.raised[0])
    expect(proposal?.source).toBe('reflection')
    expect(proposal?.status).toBe('draft')
    // The dedup tag is stamped on the draft (kpi_tag column).
    const tagged = await findOpenDraftByKpiTag(scorerTrendKpiTag('task'))
    expect(tagged?.id).toBe(first.raised[0])

    // Level-triggered dedup: a second evaluation is a no-op while the draft
    // is open.
    const second = await runScorerLowTrendTrigger()
    expect(second.raised).toHaveLength(0)
    expect(second.skipped).toContainEqual({ workflow: 'task', reason: 'duplicate' })
  })

  it('with opt-in ON, a healthy median raises nothing', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({
        scoring: { autoTrigger: true, lowTrendThreshold: 0.5, lowTrendWindow: 3 },
      }),
      'utf8',
    )
    const m = await loadMods(repo)
    for (let i = 0; i < 3; i += 1) {
      await m.sr.recordScorerResult({
        scorerId: `sc-h-${i}`,
        taskId: `t-h-${i}`,
        workflow: 'task',
        score: 0.9,
        rationale: 'strong',
        status: 'scored',
      })
    }
    const { runScorerLowTrendTrigger } = await import('../lib/scorer-trend-trigger')
    const result = await runScorerLowTrendTrigger()
    expect(result.raised).toHaveLength(0)
    expect(result.skipped).toContainEqual({ workflow: 'task', reason: 'healthy' })
  })
})
