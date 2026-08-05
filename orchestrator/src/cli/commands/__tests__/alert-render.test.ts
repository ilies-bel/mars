/**
 * Tests for `renderArcAlertBlock` (mars alert list display format).
 *
 * Covers:
 *   - multi-hop arc: origin → fix-1 → fix-2 (tip), N tasks blocked behind it.
 *     The rendered block must name the tip with its fix-attempt label, print the
 *     chain of ids, include the failure signature + phase, and show the blast
 *     radius (blocks:<N>).
 *   - single-node arc: origin itself is the tip. No chain line is rendered
 *     (a chain of one adds no information over the tip line that already shows the id).
 *   - zero blocked: "blocks:0" is suppressed — unremarkable.
 *   - missing signature: why line falls back to the reason text alone.
 */

import { describe, expect, it } from 'vitest'
import { renderArcAlertBlock } from '../alert'
import type { Alert } from '../../../core/lib/alert'

/** Collect all lines emitted by renderArcAlertBlock into an array. */
const render = (alert: Alert): string[] => {
  const lines: string[] = []
  renderArcAlertBlock(alert, (s) => lines.push(s))
  return lines
}

// ── Multi-hop arc ─────────────────────────────────────────────────────────────

describe('renderArcAlertBlock — multi-hop arc', () => {
  const alert: Alert = {
    arcId: 'mars-6bf3c343',
    kind: 'arc-failed',
    goal: 'Make web search a Daniel tool backed by grounding',
    reason: 'coder process exited 143',
    technical:
      'signature: code:coder-exit-nonzero/unclassified\ncoder process exited 143',
    chain: [
      { kind: 'task', id: 'mars-6bf3c343', status: 'done', label: 'origin' },
      { kind: 'task', id: 'fix-c3b35967', status: 'done', label: 'fix-1' },
      { kind: 'task', id: 'fix-657e2be7', status: 'failed', label: 'fix-2' },
    ],
    failureSignature: 'code:coder-exit-nonzero/unclassified',
    failedPhase: 'code',
    blockedCount: 3,
  }

  it('header names the arc id, kind, and blocked count', () => {
    const lines = render(alert)
    expect(lines[0]).toBe('mars-6bf3c343  arc-failed  blocks:3')
  })

  it('goal line shows the arc goal', () => {
    const lines = render(alert)
    expect(lines.some((l) => l.includes('Make web search a Daniel tool backed by grounding'))).toBe(true)
  })

  it('tip line names the failing fix task with attempt index', () => {
    const lines = render(alert)
    const tipLine = lines.find((l) => l.trim().startsWith('tip:'))
    expect(tipLine).toBeDefined()
    // Should name fix-657e2be7 as attempt 2/2 (second of two fix tasks)
    expect(tipLine).toContain('fix-657e2be7')
    expect(tipLine).toContain('fix, attempt 2/2')
  })

  it('tip line includes the failed phase', () => {
    const lines = render(alert)
    const tipLine = lines.find((l) => l.trim().startsWith('tip:'))
    expect(tipLine).toContain('phase=code')
  })

  it('chain line shows the full origin → fix chain', () => {
    const lines = render(alert)
    const chainLine = lines.find((l) => l.trim().startsWith('chain:'))
    expect(chainLine).toBeDefined()
    expect(chainLine).toContain('mars-6bf3c343')
    expect(chainLine).toContain('fix-c3b35967')
    expect(chainLine).toContain('fix-657e2be7')
    // Ordered with arrows
    expect(chainLine).toContain('mars-6bf3c343 → fix-c3b35967 → fix-657e2be7')
  })

  it('why line includes the failure signature and the reason', () => {
    const lines = render(alert)
    const whyLine = lines.find((l) => l.trim().startsWith('why:'))
    expect(whyLine).toBeDefined()
    expect(whyLine).toContain('code:coder-exit-nonzero/unclassified')
    expect(whyLine).toContain('coder process exited 143')
  })
})

// ── Single-node arc (origin is the tip) ──────────────────────────────────────

describe('renderArcAlertBlock — single-node arc (origin is the tip)', () => {
  const alert: Alert = {
    arcId: 'mars-abc12345',
    kind: 'arc-failed',
    goal: 'Fix the authentication flow',
    reason: 'tests failed in the verify step',
    technical: 'signature: verify:test-failure/unknown',
    chain: [
      { kind: 'task', id: 'mars-abc12345', status: 'failed', label: 'origin' },
    ],
    failureSignature: 'verify:test-failure/unknown',
    failedPhase: 'verify',
    blockedCount: 0,
  }

  it('header shows arc id and kind without a blocks label when blockedCount is 0', () => {
    const lines = render(alert)
    expect(lines[0]).toBe('mars-abc12345  arc-failed')
    expect(lines[0]).not.toContain('blocks:')
  })

  it('tip line names the origin task id (the sole task node)', () => {
    const lines = render(alert)
    const tipLine = lines.find((l) => l.trim().startsWith('tip:'))
    expect(tipLine).toBeDefined()
    expect(tipLine).toContain('mars-abc12345')
  })

  it('does NOT render a chain line for a single-node arc', () => {
    const lines = render(alert)
    const chainLine = lines.find((l) => l.trim().startsWith('chain:'))
    expect(chainLine).toBeUndefined()
  })

  it('why line still renders for a single-node arc', () => {
    const lines = render(alert)
    const whyLine = lines.find((l) => l.trim().startsWith('why:'))
    expect(whyLine).toBeDefined()
    expect(whyLine).toContain('verify:test-failure/unknown')
  })
})

// ── Blast radius suppressed when zero ─────────────────────────────────────────

describe('renderArcAlertBlock — blocks:0 suppressed', () => {
  it('does not print blocks:0 when blockedCount is 0', () => {
    const alert: Alert = {
      arcId: 'mars-leaf-001',
      kind: 'arc-failed',
      goal: 'leaf failure with no downstream dependents',
      reason: 'something went wrong',
      technical: 'signature: code:timeout',
      chain: [{ kind: 'task', id: 'mars-leaf-001', status: 'failed', label: 'origin' }],
      failureSignature: 'code:timeout',
      blockedCount: 0,
    }
    const lines = render(alert)
    expect(lines[0]).not.toContain('blocks:')
  })

  it('does not print blocks when blockedCount is undefined', () => {
    const alert: Alert = {
      arcId: 'mars-no-count',
      kind: 'arc-failed',
      goal: 'stale worktree scenario',
      reason: 'leftover worktree',
      technical: 'signature: stale-worktree/leftover',
      chain: [{ kind: 'task', id: 'mars-no-count', status: 'failed', label: 'origin' }],
    }
    const lines = render(alert)
    expect(lines[0]).not.toContain('blocks:')
  })
})

// ── Missing signature falls back to reason-only why line ──────────────────────

describe('renderArcAlertBlock — missing failure signature', () => {
  it('why line shows reason alone when failureSignature is absent', () => {
    const alert: Alert = {
      arcId: 'mars-nosig-001',
      kind: 'arc-failed',
      goal: 'task with no structured signature',
      reason: 'something unclassified happened',
      technical: 'signature: unclassified',
      chain: [{ kind: 'task', id: 'mars-nosig-001', status: 'failed', label: 'origin' }],
    }
    const lines = render(alert)
    const whyLine = lines.find((l) => l.trim().startsWith('why:'))
    expect(whyLine).toBeDefined()
    expect(whyLine).toContain('something unclassified happened')
    // No ' — ' separator when signature is absent
    expect(whyLine).not.toContain(' — ')
  })
})
