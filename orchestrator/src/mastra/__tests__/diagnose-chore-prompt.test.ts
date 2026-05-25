/**
 * Acceptance tests for the diagnose-Chore spawning path introduced by
 * PRD 06e677fb (end the degenerate context-gathering recursion).
 *
 * What this suite covers (vertical slice — mars-80876a8f):
 *   AC1 — A stalled task produces exactly ONE diagnose Chore as its blocker;
 *          the invariant is enforced by disabling the read-span guard on
 *          diagnose Chores (shouldWireReadSpanWatcher returns false for them).
 *   AC2 — The Chore's instructions forbid attempting the original work or
 *          making the fix, and require recording exactly one verdict via
 *          `mars diagnose set`.
 *   AC3 — The old three-way free-form wording is absent from the Chore prompt.
 *   AC4 — The Chore's prompt carries the parent task intent and read trail.
 *   AC5 — Operator-facing identifiers (abort message, log sentinel) describe
 *          the spawned step as a "diagnose Chore", not a "context-gathering
 *          child".
 */

import { describe, expect, it } from 'vitest'
import {
  shouldWireReadSpanWatcher,
  isTooHardAbortError,
  TOO_HARD_ABORT_MESSAGE,
} from '../workflows/implement-workflow'
import { buildDiagnoseChorePrompt } from '../lib/diagnose-chore'
import type { ReadSpanTrace } from '../lib/read-span-watch'

const SAMPLE_TRACE: readonly ReadSpanTrace[] = [
  { tool: 'Read', target: 'src/api.ts' },
  { tool: 'Grep', target: 'handleRequest' },
  { tool: 'Read', target: 'src/router.ts' },
  { tool: 'Glob', target: 'src/**/*.ts' },
  { tool: 'Read', target: 'src/middleware.ts' },
]

// ── AC1: exactly one Chore, original task blocked ──────────────────────────
// The recursion invariant is enforced structurally: diagnose Chores must NOT
// get the read-span watcher wired (which is what would spawn another Chore).
// Testing the predicate directly is the only way to verify this without a
// live DB.

describe('shouldWireReadSpanWatcher — read-span guard exemption', () => {
  it('does NOT wire the guard for diagnose Chores (AC1: prevents recursive spawning)', () => {
    expect(shouldWireReadSpanWatcher('diagnose')).toBe(false)
  })

  it('wires the guard for ordinary tasks', () => {
    expect(shouldWireReadSpanWatcher('task')).toBe(true)
  })

  it('wires the guard for fix tasks', () => {
    expect(shouldWireReadSpanWatcher('fix')).toBe(true)
  })
})

// ── AC5: operator-facing identifiers say "diagnose Chore", not legacy terms ─

describe('TOO_HARD_ABORT_MESSAGE and isTooHardAbortError sentinel (AC5)', () => {
  it('abort message names the spawned step "diagnose Chore", not a generic context-gathering child', () => {
    const msg = TOO_HARD_ABORT_MESSAGE('mars-abc00001')
    expect(msg).toContain('diagnose Chore')
    expect(msg).not.toMatch(/context.gathering/i)
    expect(msg).not.toMatch(/generic child/i)
  })

  it('abort message includes the parent task id so it is traceable in logs', () => {
    const msg = TOO_HARD_ABORT_MESSAGE('mars-abc00001')
    expect(msg).toContain('mars-abc00001')
  })

  it('isTooHardAbortError recognises the sentinel thrown after a successful Chore spawn', () => {
    const err = new Error(TOO_HARD_ABORT_MESSAGE('mars-abc00001'))
    expect(isTooHardAbortError(err)).toBe(true)
  })

  it('isTooHardAbortError rejects unrelated errors', () => {
    expect(isTooHardAbortError(new Error('some unrelated failure'))).toBe(false)
    expect(isTooHardAbortError(new Error(''))).toBe(false)
    expect(isTooHardAbortError(null)).toBe(false)
  })
})

// ── AC2, AC3, AC4: Chore prompt content ───────────────────────────────────

describe('buildDiagnoseChorePrompt — Chore instruction content', () => {
  const parentId = 'mars-deadbeef'
  const parentPrompt =
    'Add request-level logging to src/api.ts so every 4xx response is written to the structured error log.'

  it('carries the original task intent (parent prompt) verbatim (AC4)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).toContain(parentPrompt)
  })

  it('carries the parent task id (AC4)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).toContain(parentId)
  })

  it('carries the read trail that preceded the stall (AC4)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).toContain('## Read trail before abort')
    // Every tool in the trace appears in the output
    expect(out).toContain('src/api.ts')
    expect(out).toContain('handleRequest')
    expect(out).toContain('src/router.ts')
    expect(out).toContain('Grep')
  })

  it('explicitly forbids attempting the parent task work (AC2)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).toMatch(/MUST NOT/)
    expect(out).toMatch(/attempt the parent task/)
  })

  it('explicitly forbids making the fix itself (AC2)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).toMatch(/make the fix yourself/)
  })

  it('requires recording exactly one verdict via mars diagnose set (AC2)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).toMatch(new RegExp(`mars diagnose set ${parentId} --from -`))
    // Both verdict kinds must be documented
    expect(out).toContain('"kind": "root-cause-found"')
    expect(out).toContain('"kind": "inconclusive"')
  })

  it('forbids spawning another diagnose Chore (AC2 — terminality invariant)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).toMatch(/spawn another diagnose Chore/)
  })

  it('does not contain the legacy "produce a concise note" wording (AC3)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).not.toMatch(/produce a concise note/i)
  })

  it('does not contain the legacy "small surgical change" wording (AC3)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).not.toMatch(/small surgical change/i)
  })

  it('does not contain the legacy "mars proposal add" escape hatch (AC3)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).not.toMatch(/mars proposal add/i)
  })

  it('does not contain any "note OR … OR idea" three-way instruction (AC3)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).not.toMatch(/note OR.*change OR.*idea/i)
    expect(out).not.toMatch(/file a `mars proposal/i)
  })

  it('tells the agent it is exempt from the read-span guard (AC2 — read-span exemption)', () => {
    const out = buildDiagnoseChorePrompt(parentId, parentPrompt, SAMPLE_TRACE)
    expect(out).toMatch(/exempt from the read-span guard/)
  })
})
