/**
 * Integration tests for the reflector's fingerprint-based dedup logic.
 *
 * These tests exercise the observable behaviour of persistSuggestions and
 * applyVerdicts through the SQLite DB (a real system boundary) rather than
 * mocking internal collaborators. Pattern mirrors proposals-migration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@libsql/client'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-reflect-persist-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const countProposals = async (url: string): Promise<number> => {
  const c = createClient({ url })
  const r = await c.execute(`SELECT COUNT(*) AS n FROM proposals`)
  c.close()
  return Number((r.rows[0] as unknown as { n: number | bigint }).n)
}

const getProposalNotes = async (url: string, fingerprint: string): Promise<string> => {
  const c = createClient({ url })
  const r = await c.execute({
    sql: `SELECT notes FROM proposals WHERE fingerprint = ?`,
    args: [fingerprint],
  })
  c.close()
  if (r.rows.length === 0) return ''
  return (r.rows[0] as unknown as { notes: string }).notes ?? ''
}

describe('reflector persist dedup', () => {
  let repo: string
  let stateDbUrl: string

  beforeEach(() => {
    repo = setupRepo()
    stateDbUrl = `file:${repo}/.mars/mars.db`
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('first call with rootCauseKey creates exactly one proposal', async () => {
    const { persistSuggestions } = await import('../reflector')

    await persistSuggestions(
      [
        {
          title: 'Fix typecheck failures',
          prompt: 'Fix the typecheck errors. Save your work.',
          rationale: 'tasks task-a, task-b both failed with TS2345',
          rootCauseKey: 'typecheck_failure',
          affectedTaskIds: ['task-a', 'task-b'],
          frequency: 2,
        },
      ],
      'source-task-1',
    )

    expect(await countProposals(stateDbUrl)).toBe(1)
  })

  it('second call with same rootCauseKey appends evidence and creates no new proposal', async () => {
    const { persistSuggestions } = await import('../reflector')

    const suggestion = {
      title: 'Fix typecheck failures',
      prompt: 'Fix the typecheck errors. Save your work.',
      rationale: 'tasks task-a, task-b both failed with TS2345',
      rootCauseKey: 'typecheck_failure',
      affectedTaskIds: ['task-a', 'task-b'],
      frequency: 2,
    }

    await persistSuggestions([suggestion], 'source-task-1')
    expect(await countProposals(stateDbUrl)).toBe(1)

    // Second run: same root cause, new affected tasks
    await persistSuggestions(
      [
        {
          ...suggestion,
          rationale: 'task-c also failed with TS2345',
          affectedTaskIds: ['task-c'],
          frequency: 1,
        },
      ],
      'source-task-2',
    )

    // Still only 1 proposal — no duplicate created
    expect(await countProposals(stateDbUrl)).toBe(1)

    // The fingerprint is deterministic: sha256('reflection:typecheck_failure:').slice(0,32)
    const { createHash } = await import('node:crypto')
    const fingerprint = createHash('sha256')
      .update('reflection:typecheck_failure:')
      .digest('hex')
      .slice(0, 32)

    // Notes should contain the newly appended evidence
    const notes = await getProposalNotes(stateDbUrl, fingerprint)
    expect(notes).toMatch(/task-c/)
  })

  it('different rootCauseKey creates separate proposals', async () => {
    const { persistSuggestions } = await import('../reflector')

    await persistSuggestions(
      [
        {
          title: 'Fix typecheck failures',
          prompt: 'Fix typechecks. Save your work.',
          rationale: 'task-a TS2345',
          rootCauseKey: 'typecheck_failure',
          affectedTaskIds: ['task-a'],
          frequency: 1,
        },
        {
          title: 'Improve cache hit ratio',
          prompt: 'Warm the cache. Save your work.',
          rationale: 'cache ratio 0.2 on code step',
          rootCauseKey: 'cache_miss_code_step',
          affectedTaskIds: ['task-b'],
          frequency: 1,
        },
      ],
      'source-task-1',
    )

    expect(await countProposals(stateDbUrl)).toBe(2)
  })

  it('suggestion without rootCauseKey always creates a new proposal (no dedup)', async () => {
    const { persistSuggestions } = await import('../reflector')

    const bare = {
      title: 'Generic cleanup',
      prompt: 'Do a cleanup. Save your work.',
      rationale: null,
      rootCauseKey: '',
      affectedTaskIds: [],
      frequency: 1,
    }

    await persistSuggestions([bare], 'source-task-1')
    await persistSuggestions([bare], 'source-task-2')

    // No fingerprint → no dedup → two rows
    expect(await countProposals(stateDbUrl)).toBe(2)
  })

  it('applyVerdicts save path routes through the same fingerprint dedup', async () => {
    const { applyVerdicts } = await import('../reflector')

    const verdictedSuggestion = {
      title: 'Fix merge aborts',
      prompt: 'Investigate the merge abort pattern. Save your work.',
      rationale: 'tasks task-x, task-y both aborted on merge',
      rootCauseKey: 'merge_abort_pattern',
      affectedTaskIds: ['task-x', 'task-y'],
      frequency: 2,
      verdict: 'save' as const,
      targetId: null,
      dupOf: null,
    }

    const first = await applyVerdicts([verdictedSuggestion], 'src-task-1')
    expect(first.saved).toBe(1)
    expect(await countProposals(stateDbUrl)).toBe(1)

    // Second run with same rootCauseKey — should append, not create
    const second = await applyVerdicts(
      [
        {
          ...verdictedSuggestion,
          rationale: 'task-z also aborted',
          affectedTaskIds: ['task-z'],
          frequency: 1,
        },
      ],
      'src-task-2',
    )
    // Still counts as "saved" from applyVerdicts perspective (dedup is transparent)
    expect(second.saved).toBe(1)
    // But no new row was created
    expect(await countProposals(stateDbUrl)).toBe(1)
  })
})
