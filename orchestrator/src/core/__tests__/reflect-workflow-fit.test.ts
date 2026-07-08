/**
 * Tests for `evaluateWorkflowFit` — the pure evaluation function that analyses
 * a session's step runs and arc token totals to propose workflow-fit improvements.
 *
 * Two covered scenarios (per the slice acceptance criteria):
 *   1. Manual step that timed out → proposes replacing it with a runbook split.
 *   2. Excessive token spend on a single step/task → proposes the
 *      progressive-discovery skill.
 *
 * Persistence tests verify that draft proposals land in the DB with
 * source='reflection' when the caller does insert them, and that the DB stays
 * empty when the caller skips insertion (the --dry-run path).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  evaluateWorkflowFit,
  type WorkflowFitInput,
} from '../reflect-workflow-fit'
import type { SessionStepRun } from '../lib/deep-reflect-query'

// ── Test helpers ───────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-wf-fit-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Build a minimal SessionStepRun with sensible defaults. */
const makeStep = (
  overrides: Partial<SessionStepRun> & Pick<SessionStepRun, 'stepName' | 'status'>,
): SessionStepRun => ({
  taskId: 'task-1',
  attempt: 1,
  startedAtMs: 1_000,
  finishedAtMs: 2_000,
  durationMs: 1_000,
  errorSummary: null,
  summary: null,
  ...overrides,
})

/** Build a minimal arc task record. */
const makeTask = (
  taskId: string,
  tokens: { input: number; output: number },
) => ({
  taskId,
  totals: {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
  },
})

// ── Pure evaluation tests (no DB) ─────────────────────────────────────────────

describe('evaluateWorkflowFit — manual step timeout detection', () => {
  it('proposes runbook split when a manual step has failed status', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-abc',
      arcs: [{ tasks: [makeTask('task-1', { input: 100, output: 100 })] }],
      stepRuns: [
        makeStep({ stepName: 'manual-validation', status: 'failed', taskId: 'task-1' }),
      ],
    }

    const specs = evaluateWorkflowFit(input)

    const spec = specs.find((s) => s.kpiTag === 'workflow_manual_step_timeout')
    expect(spec).toBeDefined()
    expect(spec!.title).toContain('runbook split')
    expect(spec!.solution).toContain('manual-validation')
    expect(spec!.notes).toContain('session-abc')
  })

  it('proposes runbook split when a manual step duration exceeds 4 hours', () => {
    const OVER_FOUR_HOURS_MS = 4 * 60 * 60 * 1000 + 1
    const input: WorkflowFitInput = {
      sessionId: 'session-def',
      arcs: [{ tasks: [makeTask('task-1', { input: 100, output: 100 })] }],
      stepRuns: [
        makeStep({
          stepName: 'human-review',
          status: 'done',
          durationMs: OVER_FOUR_HOURS_MS,
          taskId: 'task-1',
        }),
      ],
    }

    const specs = evaluateWorkflowFit(input)

    expect(specs.some((s) => s.kpiTag === 'workflow_manual_step_timeout')).toBe(true)
  })

  it('does not flag a successful manual step within the timeout threshold', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-ok',
      arcs: [{ tasks: [makeTask('task-1', { input: 100, output: 100 })] }],
      stepRuns: [
        makeStep({
          stepName: 'manual-validation',
          status: 'done',
          durationMs: 60_000, // 1 minute — well within threshold
          taskId: 'task-1',
        }),
      ],
    }

    const specs = evaluateWorkflowFit(input)

    expect(specs.some((s) => s.kpiTag === 'workflow_manual_step_timeout')).toBe(false)
  })

  it('does not flag non-manual steps that fail', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-autofail',
      arcs: [{ tasks: [makeTask('task-1', { input: 100, output: 100 })] }],
      stepRuns: [
        makeStep({ stepName: 'run-claude-code', status: 'failed', taskId: 'task-1' }),
        makeStep({ stepName: 'verify', status: 'failed', taskId: 'task-1' }),
      ],
    }

    const specs = evaluateWorkflowFit(input)

    expect(specs.some((s) => s.kpiTag === 'workflow_manual_step_timeout')).toBe(false)
  })

  it('deduplicate step names in the proposal when the same step fails multiple times', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-repeat',
      arcs: [{ tasks: [makeTask('task-1', { input: 100, output: 100 })] }],
      stepRuns: [
        makeStep({ stepName: 'manual-check', status: 'failed', attempt: 1, taskId: 'task-1' }),
        makeStep({ stepName: 'manual-check', status: 'failed', attempt: 2, taskId: 'task-1' }),
      ],
    }

    const specs = evaluateWorkflowFit(input)
    const spec = specs.find((s) => s.kpiTag === 'workflow_manual_step_timeout')

    // 'manual-check' should appear once in the solution even though two runs failed
    expect(spec!.solution.split('manual-check').length - 1).toBe(1)
  })
})

describe('evaluateWorkflowFit — token outlier detection', () => {
  it('proposes progressive-discovery when one task is >3× the session mean', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-tokens',
      arcs: [
        {
          tasks: [
            makeTask('light-task', { input: 500, output: 200 }),    // 700 weighted tokens
            makeTask('heavy-task', { input: 8_000, output: 4_000 }), // 12,000 — ≈17× mean
          ],
        },
      ],
      stepRuns: [],
    }

    const specs = evaluateWorkflowFit(input)

    const spec = specs.find((s) => s.kpiTag === 'workflow_token_outlier_step')
    expect(spec).toBeDefined()
    expect(spec!.title).toContain('progressive-discovery')
    expect(spec!.solution).toContain('heavy-task')
  })

  it('does not flag tasks with balanced token spend', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-balanced',
      arcs: [
        {
          tasks: [
            makeTask('task-a', { input: 1_000, output: 500 }),
            makeTask('task-b', { input: 1_100, output: 550 }),
            makeTask('task-c', { input: 900, output: 450 }),
          ],
        },
      ],
      stepRuns: [],
    }

    const specs = evaluateWorkflowFit(input)

    expect(specs.some((s) => s.kpiTag === 'workflow_token_outlier_step')).toBe(false)
  })

  it('flags a single task with absolute spend above 50k weighted tokens', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-single-heavy',
      arcs: [
        {
          tasks: [makeTask('solo-task', { input: 40_000, output: 20_000 })], // 60k > 50k
        },
      ],
      stepRuns: [],
    }

    const specs = evaluateWorkflowFit(input)

    expect(specs.some((s) => s.kpiTag === 'workflow_token_outlier_step')).toBe(true)
  })

  it('does not flag a single task below the 50k absolute threshold', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-single-light',
      arcs: [{ tasks: [makeTask('solo-task', { input: 1_000, output: 500 })] }],
      stepRuns: [],
    }

    const specs = evaluateWorkflowFit(input)

    expect(specs.some((s) => s.kpiTag === 'workflow_token_outlier_step')).toBe(false)
  })

  it('includes session mean in proposal solution text for multi-task sessions', () => {
    const input: WorkflowFitInput = {
      sessionId: 'session-mean-note',
      arcs: [
        {
          tasks: [
            makeTask('light', { input: 500, output: 200 }),
            makeTask('heavy', { input: 8_000, output: 4_000 }),
          ],
        },
      ],
      stepRuns: [],
    }

    const specs = evaluateWorkflowFit(input)
    const spec = specs.find((s) => s.kpiTag === 'workflow_token_outlier_step')

    expect(spec!.solution).toContain('session mean')
  })
})

describe('evaluateWorkflowFit — combined and edge cases', () => {
  it('returns both proposals when both outliers are present', () => {
    const OVER_FOUR_HOURS_MS = 4 * 60 * 60 * 1000 + 1
    const input: WorkflowFitInput = {
      sessionId: 'session-combo',
      arcs: [
        {
          tasks: [
            makeTask('light', { input: 500, output: 200 }),
            makeTask('heavy', { input: 8_000, output: 4_000 }),
          ],
        },
      ],
      stepRuns: [
        makeStep({
          stepName: 'manual-approval',
          status: 'done',
          durationMs: OVER_FOUR_HOURS_MS,
          taskId: 'light',
        }),
      ],
    }

    const specs = evaluateWorkflowFit(input)

    expect(specs.some((s) => s.kpiTag === 'workflow_manual_step_timeout')).toBe(true)
    expect(specs.some((s) => s.kpiTag === 'workflow_token_outlier_step')).toBe(true)
  })

  it('returns empty array for a session with no arcs and no steps', () => {
    const specs = evaluateWorkflowFit({
      sessionId: 'session-empty',
      arcs: [],
      stepRuns: [],
    })

    expect(specs).toHaveLength(0)
  })
})

// ── Persistence tests (real DB via temp repo) ─────────────────────────────────

describe('workflow-fit proposal persistence', () => {
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

  it('inserts draft proposals with source=reflection when specs are persisted', async () => {
    const { initProposals, createProposal, listProposals } = await import(
      '../proposals'
    )
    await initProposals()

    const input: WorkflowFitInput = {
      sessionId: 'session-persist',
      arcs: [
        {
          tasks: [
            makeTask('task-a', { input: 500, output: 200 }),
            makeTask('task-b', { input: 8_000, output: 4_000 }),
          ],
        },
      ],
      stepRuns: [
        makeStep({ stepName: 'manual-validation', status: 'failed', taskId: 'task-a' }),
      ],
    }
    const specs = evaluateWorkflowFit(input)
    expect(specs.length).toBeGreaterThan(0)

    // Simulate normal (non-dry-run) path: caller inserts proposals.
    for (const spec of specs) {
      await createProposal(spec.title, {
        source: 'reflection',
        solution: spec.solution,
        notes: spec.notes,
        kpiTag: spec.kpiTag,
      })
    }

    const proposals = await listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(specs.length)
    for (const p of proposals) {
      expect(p.source).toBe('reflection')
      expect(p.status).toBe('draft')
    }
  })

  it('dry-run: skipping createProposal leaves the DB empty', async () => {
    const { initProposals, listProposals } = await import('../proposals')
    await initProposals()

    const input: WorkflowFitInput = {
      sessionId: 'session-dryrun',
      arcs: [
        {
          tasks: [
            makeTask('task-1', { input: 500, output: 200 }),
            makeTask('task-2', { input: 8_000, output: 4_000 }),
          ],
        },
      ],
      stepRuns: [],
    }
    const specs = evaluateWorkflowFit(input)
    expect(specs.length).toBeGreaterThan(0) // would produce proposals

    // Simulate --dry-run: evaluate but do NOT call createProposal.
    const proposals = await listProposals({ source: 'reflection' })
    expect(proposals).toHaveLength(0) // nothing was inserted
  })
})
