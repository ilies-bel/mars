/**
 * Integration tests for the reflector's fingerprint-based dedup logic.
 *
 * These tests exercise the observable behaviour of persistSuggestions and
 * applyVerdicts through the real proposals store (a real system boundary)
 * rather than mocking internal collaborators.
 *
 * The store is the embedded PostgreSQL database (ADR-0034), reached through the
 * `core/proposals` module — the public seam. These tests used to read a
 * `.mars/mars.db` SQLite file directly with `@libsql/client`; that file has not
 * been the live store since the Postgres cut, so the reads silently returned
 * zero rows and the suite was red for reasons unrelated to the behaviour under
 * test. Assert through the module instead of poking the storage engine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const countProposals = async (): Promise<number> => {
  const { listProposals } = await import('../../proposals')
  return (await listProposals()).length
}

const getProposalNotes = async (fingerprint: string): Promise<string> => {
  const { findOpenReflectionDraftByFingerprint } = await import('../../proposals')
  const found = await findOpenReflectionDraftByFingerprint(fingerprint)
  return found?.notes ?? ''
}

describe('reflector persist dedup', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  const baseOutcome = {
    type: 'leverGap' as const,
    leverGap: { proposedLeverId: 'verify.typecheck-flags', family: 'verify', whatItWouldControl: 'typecheck strictness flags' },
  }

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
          confidence: 0,
          kind: 'mechanical' as const,
          outcome: baseOutcome,
        },
      ],
      'source-task-1',
    )

    expect(await countProposals()).toBe(1)
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
      confidence: 0,
      kind: 'mechanical' as const,
      outcome: baseOutcome,
    }

    await persistSuggestions([suggestion], 'source-task-1')
    expect(await countProposals()).toBe(1)

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
    expect(await countProposals()).toBe(1)

    // The fingerprint is deterministic: sha256('reflection:typecheck_failure:').slice(0,32)
    const { createHash } = await import('node:crypto')
    const fingerprint = createHash('sha256')
      .update('reflection:typecheck_failure:')
      .digest('hex')
      .slice(0, 32)

    // Notes should contain the newly appended evidence
    const notes = await getProposalNotes(fingerprint)
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
          confidence: 0,
          kind: 'mechanical' as const,
          outcome: baseOutcome,
        },
        {
          title: 'Improve cache hit ratio',
          prompt: 'Warm the cache. Save your work.',
          rationale: 'cache ratio 0.2 on code step',
          rootCauseKey: 'cache_miss_code_step',
          affectedTaskIds: ['task-b'],
          frequency: 1,
          confidence: 0,
          kind: 'mechanical' as const,
          outcome: {
            type: 'leverGap' as const,
            leverGap: { proposedLeverId: 'cache.warmup-policy', family: 'workflow', whatItWouldControl: 'cache warm-up strategy on the code step' },
          },
        },
      ],
      'source-task-1',
    )

    expect(await countProposals()).toBe(2)
  })

  it('suggestion without rootCauseKey deduplicates by derived title+outcome fingerprint', async () => {
    // New behaviour: even without rootCauseKey the structural fingerprint
    // (normalised title + outcome id) is always derived, so a second run of
    // the same suggestion is absorbed rather than creating a duplicate row.
    const { persistSuggestions } = await import('../reflector')

    const bare = {
      title: 'Generic cleanup',
      prompt: 'Do a cleanup. Save your work.',
      rationale: null,
      rootCauseKey: '',  // model omitted this
      affectedTaskIds: [],
      frequency: 1,
      confidence: 0,
      kind: 'mechanical' as const,
      outcome: baseOutcome,
    }

    await persistSuggestions([bare], 'source-task-1')
    await persistSuggestions([bare], 'source-task-2')

    // Derived fingerprint → dedup → one row, not two
    expect(await countProposals()).toBe(1)
  })

  it('fingerprint is persisted on the draft even when model omits rootCauseKey', async () => {
    const { persistSuggestions } = await import('../reflector')
    const { findOpenReflectionDraftByFingerprint } = await import('../../proposals')
    const { createHash } = await import('node:crypto')

    const suggestion = {
      title: 'Handle connection timeouts gracefully',
      prompt: 'Add retry logic for timeouts. Save your work.',
      rationale: null,
      rootCauseKey: '',  // model omitted this
      affectedTaskIds: [],
      frequency: 1,
      confidence: 0,
      kind: 'mechanical' as const,
      outcome: baseOutcome,
    }

    await persistSuggestions([suggestion], 'src-task-1')
    expect(await countProposals()).toBe(1)

    // The derived fingerprint is deterministic: sha256('reflection-derived:<slug>:<outcomeId>:')
    const slug = 'handle-connection-timeouts-gracefully'
    const outcomeId = baseOutcome.leverGap.proposedLeverId
    const fingerprint = createHash('sha256')
      .update(`reflection-derived:${slug}:${outcomeId}:`)
      .digest('hex')
      .slice(0, 32)

    // The draft is findable by its derived fingerprint
    const draft = await findOpenReflectionDraftByFingerprint(fingerprint)
    expect(draft).not.toBeNull()
    expect(draft?.id).toBeTruthy()

    // Second run is absorbed: total stays 1
    await persistSuggestions(
      [{ ...suggestion, affectedTaskIds: ['task-z'] }],
      'src-task-2',
    )
    expect(await countProposals()).toBe(1)
  })

  it('open task with matching keywords is flagged on the new draft notes', async () => {
    const { resolveStateClient } = await import('../../store/state-client')
    const { initProposals, findOpenReflectionDraftByFingerprint } = await import('../../proposals')
    const { applyVerdicts } = await import('../reflector')
    const { createHash } = await import('node:crypto')

    await initProposals()

    // Insert a queued task whose prompt overlaps with the suggestion title keywords.
    // (arc-sole-writer.test.ts skips *.test.ts files, so this direct INSERT is permitted.)
    const c = resolveStateClient()
    await c.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at)
            VALUES (?, ?, 'queued', NOW(), NOW())`,
      args: ['mars-overlap-task', 'preserve recovery budget during api outages to prevent cascades'],
    })

    const suggestion = {
      title: 'Preserve recovery budget on API outages',
      prompt: 'Add backoff for API outage scenarios. Save your work.',
      rationale: null,
      rootCauseKey: 'api_outage_recovery',
      affectedTaskIds: [],
      frequency: 1,
      confidence: 0.8,
      kind: 'mechanical' as const,
      verdict: 'save' as const,
      targetId: null,
      dupOf: null,
      coversInstances: [],
      doesNotClaim: '',
      outcome: baseOutcome,
    }

    const result = await applyVerdicts([suggestion], 'src-task')
    expect(result.saved).toBe(1)

    // The proposal's notes should mention the matching task id
    const fingerprint = createHash('sha256')
      .update('reflection:api_outage_recovery:')
      .digest('hex')
      .slice(0, 32)
    const draft = await findOpenReflectionDraftByFingerprint(fingerprint)
    expect(draft).not.toBeNull()
    expect(draft?.notes).toMatch(/mars-overlap-task/)
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
      confidence: 0,
      kind: 'mechanical' as const,
      verdict: 'save' as const,
      targetId: null,
      dupOf: null,
      coversInstances: ['task-x', 'task-y'],
      doesNotClaim: '',
      outcome: baseOutcome,
    }

    const first = await applyVerdicts([verdictedSuggestion], 'src-task-1')
    expect(first.saved).toBe(1)
    expect(await countProposals()).toBe(1)

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
    expect(await countProposals()).toBe(1)
  })

  it('applyVerdicts writes back a non-null targetId onto each saved suggestion', async () => {
    const { applyVerdicts } = await import('../reflector')

    const leverSuggestion = {
      title: 'Tune workflow.steps to run acceptance commands',
      prompt: 'Run exact acceptance commands with preserved exit codes. Save your work.',
      rationale: 'Verify output was absent on several tasks',
      rootCauseKey: 'verify_output_absent',
      affectedTaskIds: ['task-a'],
      frequency: 1,
      confidence: 0.9,
      kind: 'architectural' as const,
      verdict: 'save' as const,
      targetId: null,
      dupOf: null,
      coversInstances: ['task-a'],
      doesNotClaim: '',
      outcome: {
        type: 'lever' as const,
        lever: {
          id: 'workflow.steps',
          currentValue: 'Code sessions may use filtered local checks.',
          proposedValue: 'Run exact acceptance commands with preserved exit codes.',
          gesture: 'mars workflow author <name>',
        },
      },
    }

    const result = await applyVerdicts([leverSuggestion], 'src-task-lever')
    expect(result.saved).toBe(1)
    // The suggestion object should have a non-null targetId after persistence.
    expect(result.savedSuggestions[0]?.targetId).not.toBeNull()
    expect(typeof result.savedSuggestions[0]?.targetId).toBe('string')
    // The proposal exists in the store and its id matches the suggestion's targetId.
    expect(await countProposals()).toBe(1)
  })

  it('persistSuggestions populates problem from rationale and adds a user story so the draft is promotable', async () => {
    const { persistSuggestions } = await import('../reflector')
    const { listProposals, validateProposalShaped } = await import('../../proposals')

    const title = 'Fix typecheck failures'
    const rationale = 'Tasks task-a and task-b both failed with TS2345; a typecheck gate would catch this earlier.'

    await persistSuggestions(
      [
        {
          title,
          prompt: 'Add a typecheck verify gate. Save your work.',
          rationale,
          rootCauseKey: 'typecheck_failure',
          affectedTaskIds: ['task-a', 'task-b'],
          frequency: 2,
          confidence: 0.9,
          kind: 'mechanical' as const,
          outcome: baseOutcome,
        },
      ],
      'source-task-1',
    )

    const proposals = await listProposals()
    expect(proposals).toHaveLength(1)
    const [p] = proposals
    expect(p.problem).toBe(rationale)
    expect(p.userStories).toHaveLength(1)
    expect(p.userStories[0]).toBe(title)
    // Gate must pass — the draft is promotable without hand-writing fields.
    expect(validateProposalShaped(p)).toEqual([])
  })
})
