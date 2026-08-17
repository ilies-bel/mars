import { describe, it, expect } from 'vitest'
import {
  uiScreenshotVerifyGapHeuristic,
  repeatedVerifyFailureReasonHeuristic,
  DEFAULT_STEP_SUGGESTION_HEURISTICS,
} from './heuristics.js'
import type { ReflectCorpusEntry } from '../core/lib/reflect-query.js'

const baseEntry = (overrides: Partial<ReflectCorpusEntry>): ReflectCorpusEntry => ({
  taskId: 't-1',
  status: 'failed',
  promptPrefix: '',
  errorTail: null,
  createdAt: new Date().toISOString(),
  failureSignature: null,
  failureReasonCode: null,
  failedPhase: null,
  kind: 'task',
  fixForTaskId: null,
  originId: null,
  toolErrorCount: 0,
  topErrorTool: null,
  signals: [],
  scorerResults: [],
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    cacheHitRatio: 0,
  },
  ...overrides,
})

describe('uiScreenshotVerifyGapHeuristic', () => {
  it('suggests a browser-check step when 2+ ui/ tasks fail verify on a screenshot signal', () => {
    const entries = [
      baseEntry({
        taskId: 't-1',
        promptPrefix: 'Fix the button in ui/components/Button.tsx',
        failedPhase: 'verify',
        errorTail: 'screenshot mismatch: hero.png differs by 4.2%',
      }),
      baseEntry({
        taskId: 't-2',
        promptPrefix: 'Update ui/pages/Home.tsx spacing',
        failedPhase: 'verify',
        errorTail: 'playwright snapshot comparison failed',
      }),
    ]
    const suggestions = uiScreenshotVerifyGapHeuristic.evaluate(entries)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].rootCauseKey).toBe('ui_verify_screenshot_gap')
    expect(suggestions[0].affectedTaskIds).toEqual(['t-1', 't-2'])
    expect(suggestions[0].proposedStep).toBe('browser-check')
  })

  it('does not suggest below the frequency floor', () => {
    const entries = [
      baseEntry({
        taskId: 't-1',
        promptPrefix: 'Fix ui/components/Button.tsx',
        failedPhase: 'verify',
        errorTail: 'screenshot mismatch',
      }),
    ]
    expect(uiScreenshotVerifyGapHeuristic.evaluate(entries)).toEqual([])
  })

  it('ignores non-ui or non-screenshot failures', () => {
    const entries = [
      baseEntry({
        taskId: 't-1',
        promptPrefix: 'Fix backend/api.ts',
        failedPhase: 'verify',
        errorTail: 'screenshot mismatch',
      }),
      baseEntry({
        taskId: 't-2',
        promptPrefix: 'Fix ui/Button.tsx',
        failedPhase: 'verify',
        errorTail: 'typecheck error: TS2322',
      }),
    ]
    expect(uiScreenshotVerifyGapHeuristic.evaluate(entries)).toEqual([])
  })

  it('ignores tasks that did not fail at the verify phase', () => {
    const entries = [
      baseEntry({
        taskId: 't-1',
        status: 'done',
        promptPrefix: 'Fix ui/Button.tsx',
        failedPhase: null,
        errorTail: null,
      }),
      baseEntry({
        taskId: 't-2',
        promptPrefix: 'Fix ui/Home.tsx',
        failedPhase: 'setup',
        errorTail: 'screenshot mismatch',
      }),
    ]
    expect(uiScreenshotVerifyGapHeuristic.evaluate(entries)).toEqual([])
  })
})

describe('repeatedVerifyFailureReasonHeuristic', () => {
  it('suggests a dedicated step when a failureReasonCode recurs 3+ times', () => {
    const entries = ['t-1', 't-2', 't-3'].map((taskId) =>
      baseEntry({ taskId, failedPhase: 'verify', failureReasonCode: 'flaky_network_call' }),
    )
    const suggestions = repeatedVerifyFailureReasonHeuristic.evaluate(entries)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0].rootCauseKey).toBe('repeated_verify_failure_flaky_network_call')
    expect(suggestions[0].affectedTaskIds).toEqual(['t-1', 't-2', 't-3'])
  })

  it('does not suggest below the frequency floor of 3', () => {
    const entries = ['t-1', 't-2'].map((taskId) =>
      baseEntry({ taskId, failedPhase: 'verify', failureReasonCode: 'flaky_network_call' }),
    )
    expect(repeatedVerifyFailureReasonHeuristic.evaluate(entries)).toEqual([])
  })

  it('ignores unset or generic reason codes', () => {
    const entries = ['t-1', 't-2', 't-3'].map((taskId) =>
      baseEntry({ taskId, failedPhase: 'verify', failureReasonCode: null }),
    )
    expect(repeatedVerifyFailureReasonHeuristic.evaluate(entries)).toEqual([])
  })

  it('emits one suggestion per distinct reason code', () => {
    const entries = [
      ...['t-1', 't-2', 't-3'].map((taskId) =>
        baseEntry({ taskId, failedPhase: 'verify', failureReasonCode: 'reason_a' }),
      ),
      ...['t-4', 't-5', 't-6'].map((taskId) =>
        baseEntry({ taskId, failedPhase: 'verify', failureReasonCode: 'reason_b' }),
      ),
    ]
    const suggestions = repeatedVerifyFailureReasonHeuristic.evaluate(entries)
    expect(suggestions.map((s) => s.rootCauseKey).sort()).toEqual([
      'repeated_verify_failure_reason_a',
      'repeated_verify_failure_reason_b',
    ])
  })
})

describe('DEFAULT_STEP_SUGGESTION_HEURISTICS', () => {
  it('includes both default heuristics exactly once', () => {
    expect(DEFAULT_STEP_SUGGESTION_HEURISTICS).toHaveLength(2)
    const ids = DEFAULT_STEP_SUGGESTION_HEURISTICS.map((h) => h.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
