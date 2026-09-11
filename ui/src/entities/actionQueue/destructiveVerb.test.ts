/**
 * Parity tests for `isDestructiveVerb`.
 *
 * Purpose: prevent the verb-set from silently diverging between the two
 * surfaces that call it (ActionQueueRow and TriagePage). Before this module
 * existed, ActionQueueRow used a fixed array and TriagePage used a regex;
 * the union was not enforced anywhere. These tests lock the expected set so
 * either surface adding a verb without updating the predicate fails here.
 *
 * Secondary: confirm the `restart-daemon` per-string semantics (the op
 * matches SAFE_RE so the op alone is safe, but a label of `'Restart daemon'`
 * does NOT match SAFE_RE because it uses a space — the DESTRUCTIVE_RE then
 * fires on the label, making the full verb destructive).
 */
import { describe, it, expect } from 'vitest'
import { isDestructiveVerb } from './destructiveVerb'

// ── Ops from ActionQueueRow's old array ──────────────────────────────────────
// These are the verbs that the widget previously checked in a hard-coded
// `['purge', 'drop', 'restart', 'dismiss', 'reject'].includes(op)` guard.
// They must all be destructive in the unified predicate.
describe('isDestructiveVerb — ActionQueueRow verb set', () => {
  it.each(['purge', 'drop', 'restart', 'dismiss', 'reject'])(
    'treats %s as destructive',
    (op) => {
      expect(isDestructiveVerb({ op })).toBe(true)
    },
  )
})

// ── Ops from TriagePage's old regex ─────────────────────────────────────────
// These are the verbs that TriagePage previously matched via
// /\b(restart|purge|drop|delete|retire|discard|wipe|remove|abort|reset)\b/i.
// 'restart', 'purge', 'drop' overlap with the widget set above.
describe('isDestructiveVerb — TriagePage verb set', () => {
  it.each(['delete', 'retire', 'discard', 'wipe', 'remove', 'abort', 'reset'])(
    'treats %s as destructive',
    (op) => {
      expect(isDestructiveVerb({ op })).toBe(true)
    },
  )
})

// ── Safe verbs (must NOT require a confirm gate) ─────────────────────────────
describe('isDestructiveVerb — safe verbs', () => {
  it.each(['continue', 'snooze', 'copy', 'link', 'open', 'view'])(
    'treats %s as safe',
    (op) => {
      expect(isDestructiveVerb({ op })).toBe(false)
    },
  )
})

// ── style override ───────────────────────────────────────────────────────────
describe('isDestructiveVerb — style:destructive override', () => {
  it('treats style:destructive as destructive regardless of op', () => {
    // A server can mark ANY verb destructive via the style field.
    expect(isDestructiveVerb({ op: 'continue', style: 'destructive' })).toBe(true)
  })

  it('does not treat style:primary as a safe override of a destructive op', () => {
    // A server saying style:'primary' for a restart verb doesn't suppress confirmation.
    expect(isDestructiveVerb({ op: 'restart', style: 'primary' })).toBe(true)
  })
})

// ── restart-daemon per-string semantics ─────────────────────────────────────
describe('isDestructiveVerb — restart-daemon carve-out', () => {
  it('op restart-daemon alone is safe (the SAFE_RE matches the hyphenated form)', () => {
    // The daemon-restart bounces the process without losing work. The op itself
    // matches SAFE_RE, so passing it without a label returns false.
    expect(isDestructiveVerb({ op: 'restart-daemon' })).toBe(false)
  })

  it('label "Restart daemon" (space, not hyphen) is destructive', () => {
    // The SAFE_RE pattern uses `restart[-_]?daemon` — a hyphen or underscore,
    // not a space. `'Restart daemon'` does NOT match SAFE_RE, so the
    // DESTRUCTIVE_RE fires on `restart` in the label.
    expect(isDestructiveVerb({ label: 'Restart daemon' })).toBe(true)
  })

  it('a full verb {op:"restart-daemon", label:"Restart daemon"} is destructive', () => {
    // This is the case that ships in the daemon-code-drift recipe. The safe op
    // alone would suppress confirmation; the label check fires independently
    // (per-string evaluation) and marks it destructive. That is intentional:
    // a button labelled "Restart daemon" LOOKS destructive to a reader.
    expect(
      isDestructiveVerb({ op: 'restart-daemon', label: 'Restart daemon', style: 'primary' }),
    ).toBe(true)
  })

  it('label "restart-daemon" (with hyphen, matching SAFE_RE) is safe', () => {
    // When the label itself is the raw slug (hyphenated), SAFE_RE catches it too.
    expect(isDestructiveVerb({ op: 'restart-daemon', label: 'restart-daemon' })).toBe(false)
  })
})
