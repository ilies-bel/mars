/**
 * scorer_results CRUD + trend computation (PRD 6cf85bc9, run half).
 *
 * Covers:
 *   - record → read-back round trip (scored and error rows)
 *   - idempotency: the UNIQUE(scorer_id, task_id) guard absorbs duplicates
 *   - list filters (workflow / scorer / task / status)
 *   - median + p90 trend over a trailing window (never a bare mean),
 *     error rows excluded from the distribution but counted
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

type ScorerResultsMod = typeof import('../scorer-results')

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-scorer-results-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMod = async (repo: string): Promise<ScorerResultsMod> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../scorer-results')
  await mod.initScorerResults()
  return mod
}

describe('scorer_results CRUD', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('records a scored row and reads it back', async () => {
    const m = await loadMod(repo)
    const { result, inserted } = await m.recordScorerResult({
      scorerId: 'sc-1',
      taskId: 'task-1',
      workflow: 'task',
      score: 0.73,
      rationale: 'diff tightly scoped to the goal',
      status: 'scored',
    })
    expect(inserted).toBe(true)
    expect(result.score).toBe(0.73)

    const fetched = await m.getScorerResult('sc-1', 'task-1')
    expect(fetched).not.toBeNull()
    expect(fetched?.score).toBe(0.73)
    expect(fetched?.rationale).toBe('diff tightly scoped to the goal')
    expect(fetched?.status).toBe('scored')
    expect(fetched?.workflow).toBe('task')
  })

  it('records an error row with a null score', async () => {
    const m = await loadMod(repo)
    await m.recordScorerResult({
      scorerId: 'sc-1',
      taskId: 'task-err',
      workflow: 'task',
      score: null,
      rationale: 'scorer verdict unparseable',
      status: 'error',
    })
    const fetched = await m.getScorerResult('sc-1', 'task-err')
    expect(fetched?.score).toBeNull()
    expect(fetched?.status).toBe('error')
  })

  it('is idempotent per (scorer, task): a duplicate insert returns the existing row', async () => {
    const m = await loadMod(repo)
    const first = await m.recordScorerResult({
      scorerId: 'sc-1',
      taskId: 'task-1',
      workflow: 'task',
      score: 0.5,
      rationale: 'first',
      status: 'scored',
    })
    const second = await m.recordScorerResult({
      scorerId: 'sc-1',
      taskId: 'task-1',
      workflow: 'task',
      score: 0.9,
      rationale: 'second attempt must not overwrite',
      status: 'scored',
    })
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.result.id).toBe(first.result.id)
    expect(second.result.score).toBe(0.5)
    const all = await m.listScorerResults({ scorerId: 'sc-1' })
    expect(all).toHaveLength(1)
  })

  it('list filters by workflow, scorer, task, and status', async () => {
    const m = await loadMod(repo)
    await m.recordScorerResult({
      scorerId: 'sc-a',
      taskId: 't1',
      workflow: 'task',
      score: 0.4,
      rationale: 'r',
      status: 'scored',
    })
    await m.recordScorerResult({
      scorerId: 'sc-b',
      taskId: 't2',
      workflow: 'other',
      score: null,
      rationale: 'boom',
      status: 'error',
    })
    expect(await m.listScorerResults({ workflow: 'task' })).toHaveLength(1)
    expect(await m.listScorerResults({ scorerId: 'sc-b' })).toHaveLength(1)
    expect(await m.listScorerResults({ taskId: 't1' })).toHaveLength(1)
    expect(await m.listScorerResults({ status: 'error' })).toHaveLength(1)
    expect(await m.listScorerResults()).toHaveLength(2)
    expect(await m.listScoredWorkflows()).toEqual(
      expect.arrayContaining(['task', 'other']),
    )
  })
})

describe('trend computation (median + p90, never a bare mean)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('medianOf and p90Of follow the documented conventions', async () => {
    const m = await loadMod(repo)
    expect(m.medianOf([])).toBeNull()
    expect(m.medianOf([0.5])).toBe(0.5)
    expect(m.medianOf([0.2, 0.4])).toBeCloseTo(0.3)
    expect(m.medianOf([0.2, 0.4, 0.6, 0.8, 1.0])).toBe(0.6)
    expect(m.p90Of([])).toBeNull()
    // nearest-rank: ceil(0.9 * 5) = 5 → the max of a 5-sample window
    expect(m.p90Of([0.2, 0.4, 0.6, 0.8, 1.0])).toBe(1.0)
    // ceil(0.9 * 10) = 9 → 9th smallest
    expect(
      m.p90Of([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]),
    ).toBe(0.9)
  })

  it('computes the per-workflow trend over scored rows, excluding but counting errors', async () => {
    const m = await loadMod(repo)
    const scores = [0.2, 0.4, 0.6, 0.8, 1.0]
    for (let i = 0; i < scores.length; i += 1) {
      await m.recordScorerResult({
        scorerId: `sc-${i}`,
        taskId: `t-${i}`,
        workflow: 'task',
        score: scores[i],
        rationale: `r${i}`,
        status: 'scored',
      })
    }
    await m.recordScorerResult({
      scorerId: 'sc-err',
      taskId: 't-err',
      workflow: 'task',
      score: null,
      rationale: 'judge died',
      status: 'error',
    })
    const trend = await m.computeScorerTrend('task', 20)
    expect(trend.sampleCount).toBe(5)
    expect(trend.errorCount).toBe(1)
    expect(trend.median).toBe(0.6)
    expect(trend.p90).toBe(1.0)
    expect(trend.latest).not.toBeNull()
  })

  it('returns an empty trend for a workflow with no results', async () => {
    const m = await loadMod(repo)
    const trend = await m.computeScorerTrend('never-scored', 10)
    expect(trend.sampleCount).toBe(0)
    expect(trend.median).toBeNull()
    expect(trend.p90).toBeNull()
    expect(trend.latest).toBeNull()
  })
})
