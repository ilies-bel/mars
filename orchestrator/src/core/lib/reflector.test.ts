/**
 * Regression tests for the leverGap framework-source guard (HR-1).
 *
 * These tests verify the four done-criteria stated in the task brief:
 *
 * 1. A leverGap suggestion whose prompt says "inspect the Mars orchestrator
 *    implementation ... verify with the relevant orchestrator test command"
 *    is rejected and warns.
 * 2. A leverGap suggestion whose prompt describes only the missing control
 *    survives.
 * 3. A lever suggestion whose prompt names a path in the operator's own
 *    repo (e.g. tsconfig.json, .github/workflows/ci.yml) still survives —
 *    this must not become collateral damage.
 * 4. The existing workflow.steps + orchestrator/src rejection still passes
 *    after being routed through the shared referencesFrameworkSource predicate.
 *
 * Strategy: exercise parseReflectionResponse end-to-end so the guard is
 * verified at the same level as the real call path. Unit-level tests for
 * parseAndValidateOutcome live in __tests__/reflector-lever-binding.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LeverRegistryEntry } from './lever-registry'

// ─── Module stubs ─────────────────────────────────────────────────────────────

vi.mock('../context', () => ({
  getRepoRoot: vi.fn().mockReturnValue('/tmp'),
  getStateDir: vi.fn().mockReturnValue('/tmp'),
  resolveContext: vi.fn().mockReturnValue({ stateDir: '/tmp' }),
  resolveDbTarget: vi.fn().mockReturnValue('pglite://reflector-hr1-test'),
}))

// Stub loadLeverRegistry so the test has a predictable, small registry.
// parseReflectionResponse calls it directly to build the registry.
vi.mock('./lever-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lever-registry')>()
  const miniEntry: LeverRegistryEntry = {
    id: 'caps.implement',
    label: 'Max implement slots',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => '12',
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars daemon set-cap implement <n>',
    appliesWithoutRestart: true,
  }
  const workflowStepsEntry: LeverRegistryEntry = {
    id: 'workflow.steps',
    label: 'User-owned workflow steps',
    family: 'workflow',
    scope: 'per-workflow',
    readCurrent: () => '(none)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars workflow author <name>',
    appliesWithoutRestart: true,
  }
  return {
    ...actual,
    loadLeverRegistry: vi.fn().mockReturnValue([miniEntry, workflowStepsEntry]),
  }
})

// ─── Import after mocks ────────────────────────────────────────────────────────

import { parseReflectionResponse } from './reflector'

// ─── Shared fixture helpers ───────────────────────────────────────────────────

const makeTokenAnalysis = () => ({
  headline: 'Normal spend.',
  tokenHeavyTasks: [],
  tokenHeavySteps: [],
  cacheHealth: null,
  successVsFailureTokens: null,
  notes: '',
})

// ─── Done criterion 1: leverGap with framework-source prompt is rejected ──────

describe('HR-1 guard — criterion 1: leverGap with orchestrator-source prompt is rejected', () => {
  it('rejects a leverGap suggestion whose prompt tells the operator to inspect the Mars orchestrator implementation', () => {
    const raw = JSON.stringify({
      tokenAnalysis: makeTokenAnalysis(),
      suggestions: [
        {
          title: 'Add commit-correction ownership lever',
          category: 'failure',
          prompt:
            'Inspect the Mars orchestrator implementation that performs ' +
            'commit-correction and recovery for task worktrees, especially the logic ' +
            'handling .mars/worktrees/<task-id>. Verify with the relevant orchestrator ' +
            'test command. Save your work.',
          rationale: 'mars-11db332f committed on the wrong branch.',
          rootCauseKey: 'commit_correction_ownership',
          affectedTaskIds: ['mars-11db332f'],
          frequency: 1,
          confidence: 0.6,
          kind: 'mechanical',
          coversInstances: ['mars-11db332f'],
          doesNotClaim: 'generalises beyond this single arc',
          outcome: {
            type: 'leverGap',
            leverGap: {
              proposedLeverId: 'orchestrator.commit-correction-ownership',
              family: 'orchestration',
              whatItWouldControl: 'who owns the commit-correction step',
            },
          },
        },
      ],
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseReflectionResponse(raw)
    expect(result.suggestions).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('leverGap suggestion rejected'),
    )
    warnSpy.mockRestore()
  })

  it('rejects a leverGap suggestion whose prompt references orchestrator/src/', () => {
    const raw = JSON.stringify({
      tokenAnalysis: makeTokenAnalysis(),
      suggestions: [
        {
          title: 'Narrow verify scope in built-in pipeline',
          category: 'failure',
          prompt:
            'Edit orchestrator/src/workflows/implement-workflow.ts step verify ' +
            'to narrow scope. Save your work.',
          rationale: 'Verify step too broad across 3 tasks.',
          rootCauseKey: 'verify_scope_too_broad',
          affectedTaskIds: ['t1', 't2', 't3'],
          frequency: 3,
          confidence: 0.75,
          kind: 'mechanical',
          coversInstances: ['t1', 't2', 't3'],
          doesNotClaim: '',
          outcome: {
            type: 'leverGap',
            leverGap: {
              proposedLeverId: 'verify.scope',
              family: 'verify',
              whatItWouldControl: 'Verify command file-scope pattern',
            },
          },
        },
      ],
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseReflectionResponse(raw)
    expect(result.suggestions).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('leverGap suggestion rejected'),
    )
    warnSpy.mockRestore()
  })
})

// ─── Done criterion 2: leverGap describing only the missing control survives ──

describe('HR-1 guard — criterion 2: leverGap describing only the missing control survives', () => {
  it('accepts a leverGap suggestion whose prompt describes the missing control without framework references', () => {
    const raw = JSON.stringify({
      tokenAnalysis: makeTokenAnalysis(),
      suggestions: [
        {
          title: 'Add slicer overlap-policy lever',
          category: 'failure',
          prompt:
            'The slicer currently distributes shared contract files across multiple tasks. ' +
            'A slicer.hotspot-overlap-policy lever would let the operator choose whether ' +
            'hotspot files are deduplicated or merged at the arc level. ' +
            'Evidence: 7 tasks in arc arc-abc123 all touched contracts/types.ts. ' +
            'Expected effect: raises completeness by reducing overlap; saves ~N tokens per arc. ' +
            'When the lever exists, set it to "merge" to eliminate the hotspot pattern.',
          rationale: '7 tasks in arc-abc123 touched the same file.',
          rootCauseKey: 'slicer_contract_overlap',
          affectedTaskIds: ['t1', 't2'],
          frequency: 7,
          confidence: 0.85,
          kind: 'architectural',
          coversInstances: ['t1', 't2'],
          doesNotClaim: 'generalises beyond arc-abc123',
          outcome: {
            type: 'leverGap',
            leverGap: {
              proposedLeverId: 'slicer.hotspot-overlap-policy',
              family: 'workflow',
              whatItWouldControl: 'how the slicer handles shared contract files across tasks',
            },
          },
        },
      ],
    })

    const result = parseReflectionResponse(raw)
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0].outcome.type).toBe('leverGap')
    expect(result.suggestions[0].title).toBe('Add slicer overlap-policy lever')
  })
})

// ─── Done criterion 3: lever suggestion with operator-repo paths still survives

describe('HR-1 guard — criterion 3: lever suggestion with operator-repo paths is not collateral damage', () => {
  it('accepts a lever suggestion whose prompt names paths in the operator\'s own repo', () => {
    const raw = JSON.stringify({
      tokenAnalysis: makeTokenAnalysis(),
      suggestions: [
        {
          title: 'Lower implement cap to 8',
          category: 'token',
          prompt:
            'Set the implement cap from 12 to 8. ' +
            'Update tsconfig.json if type errors appear after the change. ' +
            'See .github/workflows/ci.yml for the CI verification step. ' +
            'Expected effect: reduces concurrency contention; saves ~N tokens. ' +
            'Run: mars daemon set-cap implement 8. Save your work.',
          rationale: 'High implement concurrency causing contention in 3 tasks.',
          rootCauseKey: 'implement_cap_too_high',
          affectedTaskIds: ['t1', 't2', 't3'],
          frequency: 3,
          confidence: 0.8,
          kind: 'mechanical',
          coversInstances: ['t1', 't2', 't3'],
          doesNotClaim: '',
          outcome: {
            type: 'lever',
            lever: { id: 'caps.implement', currentValue: '12', proposedValue: '8' },
          },
        },
      ],
    })

    const result = parseReflectionResponse(raw)
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0].outcome.type).toBe('lever')
  })
})

// ─── Done criterion 4: workflow.steps orchestrator/src rejection via shared predicate

describe('HR-1 guard — criterion 4: workflow.steps + orchestrator/src rejection via shared predicate', () => {
  it('rejects a workflow.steps lever binding whose proposedValue references orchestrator/src/', () => {
    const raw = JSON.stringify({
      tokenAnalysis: makeTokenAnalysis(),
      suggestions: [
        {
          title: 'Narrow verify step in implement pipeline',
          category: 'failure',
          prompt:
            'Edit the workflow to narrow the verify step. ' +
            'Expected effect: reduces false failures. Save your work.',
          rationale: 'Verify step too broad.',
          rootCauseKey: 'verify_scope_broad',
          affectedTaskIds: ['t1'],
          frequency: 1,
          confidence: 0.7,
          kind: 'mechanical',
          coversInstances: ['t1'],
          doesNotClaim: '',
          outcome: {
            type: 'lever',
            lever: {
              id: 'workflow.steps',
              currentValue: '(none)',
              proposedValue:
                'Edit orchestrator/src/workflows/implement-workflow.ts step verify to narrow scope',
            },
          },
        },
      ],
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = parseReflectionResponse(raw)
    expect(result.suggestions).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(
      'workflow.steps binding rejected: proposedValue references built-in pipeline source',
    )
    warnSpy.mockRestore()
  })

  it('accepts a workflow.steps lever binding whose proposedValue references a user-owned workflow file', () => {
    const raw = JSON.stringify({
      tokenAnalysis: makeTokenAnalysis(),
      suggestions: [
        {
          title: 'Add a custom post-merge step to the user workflow',
          category: 'token',
          prompt:
            'Add a post-merge notification step to .mars/workflows/notify.js. ' +
            'Expected effect: improves completeness signal. Save your work.',
          rationale: 'Operators miss merge events.',
          rootCauseKey: 'missing_post_merge_step',
          affectedTaskIds: [],
          frequency: 1,
          confidence: 0.65,
          kind: 'mechanical',
          coversInstances: [],
          doesNotClaim: '',
          outcome: {
            type: 'lever',
            lever: {
              id: 'workflow.steps',
              currentValue: '(none)',
              proposedValue: 'Add post-merge step to .mars/workflows/notify.js',
            },
          },
        },
      ],
    })

    const result = parseReflectionResponse(raw)
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0].outcome.type).toBe('lever')
  })
})
