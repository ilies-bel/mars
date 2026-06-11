/**
 * Behavioural tests for the action-queue-watch data path and action dispatch.
 *
 * The TUI reads the daemon port from .mars/http.port (never from MARS_UI_URL
 * or a guessed default) and calls GET /view/action-queue?filter=open on the
 * daemon HTTP API. These tests verify the port-discovery, URL-construction,
 * action-dispatch, and pending-op-resolution logic exposed by the helpers.
 *
 * Coverage:
 *   - resolveDaemonBaseUrl:    port-file presence/absence/malformed
 *   - resolveActionUrl:        per-entity direct ops, batch/global ops, copy no-POST
 *   - resolveActionOutcome:    direct-op fire, batch-op fire, needsConfirm gate,
 *                              copy no-POST, confirmed override
 *   - deriveActionKeys:        de-duplicated key assignment from action ids
 *   - clearResolvedPendingOps: pending indicator clears when agent result arrives
 *
 * The Ink rendering layer is not exercised here (no ink-testing-library in the
 * test deps). What we test is the observable contract: given inputs, the exported
 * helpers produce correct outputs — URL routing is correct, the confirm gate fires
 * before POST, copy ops never reach the daemon, and the working indicator clears
 * when the SSE projection delivers the agent result.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  resolveDaemonBaseUrl,
  resolveActionUrl,
  resolveActionOutcome,
  deriveActionKeys,
  clearResolvedPendingOps,
  shouldRefreshNow,
  resolveCursor,
} from '../action-queue-watch'
import type { ActionQueueRow } from '../../core/daemon/view/action-queue'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Minimal ActionQueueRow for test purposes. */
const makeRow = (
  overrides: Partial<ActionQueueRow> & { id: string; entityId: string },
): ActionQueueRow => ({
  kind: 'failed-task',
  priority: 'normal',
  title: 'test row',
  body: '',
  at: new Date().toISOString(),
  dag: null,
  errorKind: 'unknown',
  actions: [],
  staleWorktreeDetail: null,
  diagnosis: null,
  failureReasonCode: null,
  ...overrides,
})

let tmpDir: string
let stateDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-aq-watch-test-'))
  stateDir = join(tmpDir, '.mars')
  mkdirSync(stateDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── resolveDaemonBaseUrl ─────────────────────────────────────────────────────

describe('resolveDaemonBaseUrl', () => {
  it('returns null when http.port file is absent', () => {
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns the correct base URL when http.port contains a valid port', () => {
    writeFileSync(join(stateDir, 'http.port'), '19999')
    expect(resolveDaemonBaseUrl(stateDir)).toBe('http://127.0.0.1:19999')
  })

  it('strips trailing whitespace / newlines from the port file', () => {
    writeFileSync(join(stateDir, 'http.port'), '19999\n')
    expect(resolveDaemonBaseUrl(stateDir)).toBe('http://127.0.0.1:19999')
  })

  it('returns null when http.port contains a non-numeric value', () => {
    writeFileSync(join(stateDir, 'http.port'), 'not-a-port')
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns null when http.port contains zero', () => {
    writeFileSync(join(stateDir, 'http.port'), '0')
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns null when http.port contains a negative number', () => {
    writeFileSync(join(stateDir, 'http.port'), '-1')
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns null when http.port contains a float', () => {
    writeFileSync(join(stateDir, 'http.port'), '7777.5')
    expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
  })

  it('returns null when given a completely non-existent state directory', () => {
    expect(resolveDaemonBaseUrl('/does/not/exist/.mars')).toBeNull()
  })

  it('never reads from MARS_UI_URL (env var must have no effect)', () => {
    const prev = process.env['MARS_UI_URL']
    process.env['MARS_UI_URL'] = 'http://127.0.0.1:7777'
    try {
      expect(resolveDaemonBaseUrl(stateDir)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env['MARS_UI_URL']
      else process.env['MARS_UI_URL'] = prev
    }
  })

  it('returns daemon URL based solely on http.port, regardless of MARS_UI_URL', () => {
    writeFileSync(join(stateDir, 'http.port'), '54321')
    const prev = process.env['MARS_UI_URL']
    process.env['MARS_UI_URL'] = 'http://127.0.0.1:7777'
    try {
      expect(resolveDaemonBaseUrl(stateDir)).toBe('http://127.0.0.1:54321')
    } finally {
      if (prev === undefined) delete process.env['MARS_UI_URL']
      else process.env['MARS_UI_URL'] = prev
    }
  })

  it('re-reads the file on each call — picks up a new port after http.port is rewritten', () => {
    // Simulates a daemon bounce: the new daemon writes a fresh port to http.port.
    // The reconnect loop must call resolveDaemonBaseUrl() each time, not cache the result.
    writeFileSync(join(stateDir, 'http.port'), '12345')
    expect(resolveDaemonBaseUrl(stateDir)).toBe('http://127.0.0.1:12345')
    // Daemon restarts, rewrites the port file with a new ephemeral port.
    writeFileSync(join(stateDir, 'http.port'), '54321')
    expect(resolveDaemonBaseUrl(stateDir)).toBe('http://127.0.0.1:54321')
  })
})

// ─── resolveActionUrl ─────────────────────────────────────────────────────────

describe('resolveActionUrl', () => {
  const base = 'http://127.0.0.1:19999'
  const id = 'task-abc123'

  it('builds the per-entity URL for direct op: restart', () => {
    // Direct ops use POST /actions/:op/:id
    expect(resolveActionUrl(base, id, 'restart')).toBe(
      `${base}/actions/restart/${id}`,
    )
  })

  it('builds the per-entity URL for direct op: purge', () => {
    expect(resolveActionUrl(base, id, 'purge')).toBe(`${base}/actions/purge/${id}`)
  })

  it('builds the per-entity URL for direct op: prune-worktree', () => {
    expect(resolveActionUrl(base, id, 'prune-worktree')).toBe(
      `${base}/actions/prune-worktree/${id}`,
    )
  })

  it('builds the per-entity URL for direct op: dismiss', () => {
    expect(resolveActionUrl(base, id, 'dismiss')).toBe(
      `${base}/actions/dismiss/${id}`,
    )
  })

  it('builds the per-entity URL for agent op: diagnose-failure', () => {
    expect(resolveActionUrl(base, id, 'diagnose-failure')).toBe(
      `${base}/actions/diagnose-failure/${id}`,
    )
  })

  it('builds the per-entity URL for agent op: investigate', () => {
    expect(resolveActionUrl(base, id, 'investigate')).toBe(
      `${base}/actions/investigate/${id}`,
    )
  })

  it('uses the dedicated route for batch op: restart-daemon (no :id)', () => {
    // restart-daemon is a global/process-level op — entityId is irrelevant
    expect(resolveActionUrl(base, id, 'restart-daemon')).toBe(
      `${base}/actions/restart-daemon`,
    )
  })

  it('uses the dedicated route for batch op: restart-all-daemon-killed (no :id)', () => {
    expect(resolveActionUrl(base, id, 'restart-all-daemon-killed')).toBe(
      `${base}/actions/restart-all-daemon-killed`,
    )
  })

  it('returns null for copy ops — copy must never POST to the daemon', () => {
    expect(resolveActionUrl(base, id, 'copy')).toBeNull()
  })
})

// ─── resolveActionOutcome ─────────────────────────────────────────────────────

describe('resolveActionOutcome', () => {
  const base = 'http://127.0.0.1:19999'
  const id = 'task-abc123'

  it('returns fire with the correct per-entity URL for a direct op (restart)', () => {
    const action = { op: 'restart', needsConfirm: false } as const
    const outcome = resolveActionOutcome(base, id, action)
    expect(outcome.kind).toBe('fire')
    if (outcome.kind === 'fire') {
      expect(outcome.url).toBe(`${base}/actions/restart/${id}`)
    }
  })

  it('returns fire with the dedicated route for a batch op (restart-daemon)', () => {
    const action = { op: 'restart-daemon', needsConfirm: true } as const
    // confirmed=true bypasses the gate
    const outcome = resolveActionOutcome(base, id, action, true)
    expect(outcome.kind).toBe('fire')
    if (outcome.kind === 'fire') {
      expect(outcome.url).toBe(`${base}/actions/restart-daemon`)
    }
  })

  it('returns fire with the dedicated route for restart-all-daemon-killed', () => {
    const action = { op: 'restart-all-daemon-killed' } as const
    const outcome = resolveActionOutcome(base, id, action, true)
    expect(outcome.kind).toBe('fire')
    if (outcome.kind === 'fire') {
      expect(outcome.url).toBe(`${base}/actions/restart-all-daemon-killed`)
    }
  })

  it('returns confirm-needed when action has needsConfirm and confirmed is false', () => {
    // The UI must show a confirm dialog before POSTing — no fetch yet.
    const action = { op: 'purge', needsConfirm: true } as const
    const outcome = resolveActionOutcome(base, id, action) // confirmed defaults to false
    expect(outcome.kind).toBe('confirm-needed')
  })

  it('returns fire after confirmation (confirmed=true) for a needsConfirm action', () => {
    // After y is pressed in the confirm dialog, confirmed=true bypasses the gate.
    const action = { op: 'purge', needsConfirm: true } as const
    const outcome = resolveActionOutcome(base, id, action, true)
    expect(outcome.kind).toBe('fire')
    if (outcome.kind === 'fire') {
      expect(outcome.url).toBe(`${base}/actions/purge/${id}`)
    }
  })

  it('returns copy (with hint) for copy ops — never fire', () => {
    // copy ops surface a hint for the operator to paste; they must NOT POST.
    const action = {
      op: 'copy',
      hint: '/mars:grill proposal-xyz',
    } as const
    const outcome = resolveActionOutcome(base, id, action)
    expect(outcome.kind).toBe('copy')
    if (outcome.kind === 'copy') {
      expect(outcome.hint).toBe('/mars:grill proposal-xyz')
    }
  })

  it('returns copy even when confirmed=true (copy is always client-side)', () => {
    const action = { op: 'copy', hint: '/mars:grill proposal-xyz' } as const
    const outcome = resolveActionOutcome(base, id, action, true)
    expect(outcome.kind).toBe('copy')
  })

  it('copy op uses empty string for hint when hint is undefined', () => {
    const action = { op: 'copy' } as const
    const outcome = resolveActionOutcome(base, id, action)
    expect(outcome.kind).toBe('copy')
    if (outcome.kind === 'copy') {
      expect(outcome.hint).toBe('')
    }
  })

  it('needsConfirm=false fires immediately without a confirm dialog', () => {
    const action = { op: 'restart', needsConfirm: false } as const
    const outcome = resolveActionOutcome(base, id, action) // confirmed=false, but needsConfirm is false
    expect(outcome.kind).toBe('fire')
  })

  it('returns fire for agent op: diagnose-failure (correct per-entity URL)', () => {
    const action = { op: 'diagnose-failure' } as const
    const outcome = resolveActionOutcome(base, id, action)
    expect(outcome.kind).toBe('fire')
    if (outcome.kind === 'fire') {
      expect(outcome.url).toBe(`${base}/actions/diagnose-failure/${id}`)
    }
  })

  it('returns fire for agent op: investigate (correct per-entity URL)', () => {
    const action = { op: 'investigate' } as const
    const outcome = resolveActionOutcome(base, id, action)
    expect(outcome.kind).toBe('fire')
    if (outcome.kind === 'fire') {
      expect(outcome.url).toBe(`${base}/actions/investigate/${id}`)
    }
  })
})

// ─── deriveActionKeys ─────────────────────────────────────────────────────────

describe('deriveActionKeys', () => {
  it('assigns the first letter of each action id word (simple case)', () => {
    const actions = [
      { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
      { id: 'restart', label: 'Restart', op: 'restart' },
      { id: 'purge', label: 'Purge', op: 'purge' },
    ] as ActionQueueRow['actions']
    const keys = deriveActionKeys(actions)
    expect(keys['d']?.id).toBe('diagnose-failure')
    expect(keys['r']?.id).toBe('restart')
    expect(keys['p']?.id).toBe('purge')
  })

  it('handles daemon-killed actions with colliding first letters', () => {
    // requeue → r, restart-all → r taken → tries 'a' (from 'all'), restart-daemon → r taken → tries 'a' taken → tries 'd'
    const actions = [
      { id: 'requeue', label: 'Requeue now', op: 'restart' },
      { id: 'restart-all', label: 'Restart all', op: 'restart-all-daemon-killed' },
      { id: 'restart-daemon', label: 'Restart daemon', op: 'restart-daemon', needsConfirm: true },
    ] as ActionQueueRow['actions']
    const keys = deriveActionKeys(actions)
    expect(keys['r']?.id).toBe('requeue')
    expect(keys['a']?.id).toBe('restart-all')
    expect(keys['d']?.id).toBe('restart-daemon')
  })

  it('assigns keys for stale-worktree actions', () => {
    const actions = [
      { id: 'investigate', label: 'Investigate', op: 'investigate' },
      { id: 'prune', label: 'Prune worktree', op: 'prune-worktree', needsConfirm: true },
    ] as ActionQueueRow['actions']
    const keys = deriveActionKeys(actions)
    expect(keys['i']?.id).toBe('investigate')
    expect(keys['p']?.id).toBe('prune')
  })

  it('assigns keys for draft-proposal actions (move-forward, dismiss)', () => {
    const actions = [
      { id: 'move-forward', label: 'Move forward', op: 'copy', hint: '/mars:grill xyz' },
      { id: 'dismiss', label: 'Dismiss', op: 'dismiss', needsConfirm: true },
    ] as ActionQueueRow['actions']
    const keys = deriveActionKeys(actions)
    expect(keys['m']?.id).toBe('move-forward')
    expect(keys['d']?.id).toBe('dismiss')
  })

  it('returns empty object for empty actions array', () => {
    expect(deriveActionKeys([])).toEqual({})
  })

  it('does not assign duplicate keys', () => {
    const actions = [
      { id: 'restart', label: 'Restart', op: 'restart' },
      { id: 'retry', label: 'Retry', op: 'restart' },
    ] as ActionQueueRow['actions']
    const keys = deriveActionKeys(actions)
    // Only one action gets 'r'; 'retry' needs fallback
    const rEntry = keys['r']
    expect(rEntry).toBeDefined()
    expect(Object.values(keys).filter((a) => a.op === 'restart').length).toBeGreaterThanOrEqual(1)
    // No two keys map to the same position
    const allKeys = Object.keys(keys)
    expect(new Set(allKeys).size).toBe(allKeys.length)
  })
})

// ─── clearResolvedPendingOps ──────────────────────────────────────────────────

describe('clearResolvedPendingOps', () => {
  it('clears a diagnose-failure pending op when the row has a diagnosis', () => {
    // Simulates: agent ran, SSE delivered updated row with diagnosis.
    // The pending indicator should clear so the diagnosis can render.
    const pendingOps = { 'row-1': 'diagnose-failure' }
    const updatedRows: ActionQueueRow[] = [
      makeRow({
        id: 'row-1',
        entityId: 'task-abc',
        diagnosis: { text: 'Root cause: OOM', diagnosedAt: '2026-01-01T00:00:00Z' },
      }),
    ]
    const result = clearResolvedPendingOps(pendingOps, updatedRows)
    expect(result['row-1']).toBeUndefined()
  })

  it('keeps diagnose-failure pending op while diagnosis is still null', () => {
    // Agent is still running — row has no diagnosis yet.
    const pendingOps = { 'row-1': 'diagnose-failure' }
    const updatedRows: ActionQueueRow[] = [
      makeRow({ id: 'row-1', entityId: 'task-abc', diagnosis: null }),
    ]
    const result = clearResolvedPendingOps(pendingOps, updatedRows)
    expect(result['row-1']).toBe('diagnose-failure')
  })

  it('clears an investigate pending op when staleWorktreeDetail.investigation is present', () => {
    const pendingOps = { 'row-2': 'investigate' }
    const updatedRows: ActionQueueRow[] = [
      makeRow({
        id: 'row-2',
        entityId: 'worktree-abc',
        kind: 'stale-worktree',
        staleWorktreeDetail: {
          prompt: null,
          status: 'in_progress',
          ageHours: 2.5,
          updatedAt: '2026-01-01T00:00:00Z',
          branch: 'task/abc',
          empty: false,
          investigation: 'The worktree has uncommitted changes from a failed merge.',
        },
      }),
    ]
    const result = clearResolvedPendingOps(pendingOps, updatedRows)
    expect(result['row-2']).toBeUndefined()
  })

  it('keeps investigate pending op while investigation is still null', () => {
    const pendingOps = { 'row-2': 'investigate' }
    const updatedRows: ActionQueueRow[] = [
      makeRow({
        id: 'row-2',
        entityId: 'worktree-abc',
        kind: 'stale-worktree',
        staleWorktreeDetail: {
          prompt: null,
          status: 'in_progress',
          ageHours: 2.5,
          updatedAt: '2026-01-01T00:00:00Z',
          branch: null,
          empty: false,
          investigation: null,
        },
      }),
    ]
    const result = clearResolvedPendingOps(pendingOps, updatedRows)
    expect(result['row-2']).toBe('investigate')
  })

  it('clears a pending op for a row that no longer appears in the projection', () => {
    const pendingOps = { 'row-gone': 'diagnose-failure' }
    const updatedRows: ActionQueueRow[] = [] // row was resolved and removed from queue
    const result = clearResolvedPendingOps(pendingOps, updatedRows)
    expect(result['row-gone']).toBeUndefined()
  })

  it('preserves pending ops for rows that still have no result', () => {
    const pendingOps = {
      'row-done': 'diagnose-failure',
      'row-pending': 'diagnose-failure',
    }
    const updatedRows: ActionQueueRow[] = [
      makeRow({
        id: 'row-done',
        entityId: 'task-done',
        diagnosis: { text: 'Done', diagnosedAt: '2026-01-01T00:00:00Z' },
      }),
      makeRow({ id: 'row-pending', entityId: 'task-pending', diagnosis: null }),
    ]
    const result = clearResolvedPendingOps(pendingOps, updatedRows)
    expect(result['row-done']).toBeUndefined()
    expect(result['row-pending']).toBe('diagnose-failure')
  })

  it('returns a new object (does not mutate the input)', () => {
    const pendingOps = { 'row-1': 'diagnose-failure' }
    const updatedRows: ActionQueueRow[] = [
      makeRow({
        id: 'row-1',
        entityId: 'task-abc',
        diagnosis: { text: 'done', diagnosedAt: '2026-01-01T00:00:00Z' },
      }),
    ]
    const result = clearResolvedPendingOps(pendingOps, updatedRows)
    // Input is unchanged
    expect(pendingOps['row-1']).toBe('diagnose-failure')
    // Output has the resolved op removed
    expect(result['row-1']).toBeUndefined()
  })
})

// ─── shouldRefreshNow ─────────────────────────────────────────────────────────

describe('shouldRefreshNow', () => {
  const noGates = { confirm: null, pendingOps: {}, copiedHint: null }

  it('returns true when no gate is active', () => {
    expect(shouldRefreshNow(noGates)).toBe(true)
  })

  it('returns false when a confirm dialog is active', () => {
    const row = makeRow({ id: 'r1', entityId: 'task-1' })
    const action = { id: 'restart', op: 'restart' as const, label: 'restart', needsConfirm: true }
    expect(
      shouldRefreshNow({ ...noGates, confirm: { row, action } }),
    ).toBe(false)
  })

  it('returns false when there is at least one pending op', () => {
    expect(
      shouldRefreshNow({ ...noGates, pendingOps: { 'row-1': 'diagnose-failure' } }),
    ).toBe(false)
  })

  it('returns false when a copy hint overlay is active', () => {
    expect(
      shouldRefreshNow({ ...noGates, copiedHint: 'mars task add ...' }),
    ).toBe(false)
  })

  it('returns true once confirm is cleared (all others idle)', () => {
    expect(shouldRefreshNow({ confirm: null, pendingOps: {}, copiedHint: null })).toBe(true)
  })

  /**
   * Deferred-refresh scenario: simulate the transition from blocked → clear.
   * We verify that shouldRefreshNow goes from false to true, and assert a
   * refresh() call fires exactly once — modelled via a simple counter because
   * the refresh logic lives inside React (not testable here without Ink).
   */
  it('triggers exactly one refresh when going from blocked to clear with refreshDeferred=true', () => {
    let refreshCalls = 0
    const refresh = () => { refreshCalls++ }

    // State while confirm is active + deferred refresh waiting.
    const row = makeRow({ id: 'r1', entityId: 'task-1' })
    const action = { id: 'restart', op: 'restart' as const, label: 'restart', needsConfirm: true }
    const blocked = { confirm: { row, action }, pendingOps: {} as Record<string, string>, copiedHint: null }

    expect(shouldRefreshNow(blocked)).toBe(false)

    // Simulate the confirm being dismissed (gate clears).
    const cleared = { confirm: null, pendingOps: {} as Record<string, string>, copiedHint: null }

    // The useEffect logic: when shouldRefreshNow && refreshDeferred, fire refresh once.
    const refreshDeferred = true
    if (shouldRefreshNow(cleared) && refreshDeferred) {
      refresh()
    }

    expect(refreshCalls).toBe(1)
  })
})

// ─── resolveCursor ────────────────────────────────────────────────────────────

describe('resolveCursor', () => {
  const rowA = makeRow({ id: 'row-a', entityId: 'task-a' })
  const rowB = makeRow({ id: 'row-b', entityId: 'task-b' })
  const rowC = makeRow({ id: 'row-c', entityId: 'task-c' })

  it('anchor hit: returns the new index of the previously selected row when it is still present', () => {
    // Rows had [A, B, C]; a new row was inserted above — now [X, A, B, C].
    // The cursor was on B (index 1). After refresh it should stay on B (now index 2).
    const rowX = makeRow({ id: 'row-x', entityId: 'task-x' })
    const rows = [rowX, rowA, rowB, rowC]
    expect(resolveCursor(rows, 'row-b', 1)).toBe(2)
  })

  it('anchor miss + same-index fallback: stays at prevIndex when the row is gone but index is still valid', () => {
    // Rows had [A, B, C]; B was deleted — now [A, C].
    // The cursor was on B (index 1). prevIndex 1 is still valid in [A, C].
    const rows = [rowA, rowC]
    expect(resolveCursor(rows, 'row-b', 1)).toBe(1)
  })

  it('anchor miss + clamped fallback: clamps to last row when prevIndex >= rows.length', () => {
    // Rows had [A, B, C]; last two rows were removed — now [A].
    // The cursor was on C (index 2). Clamp to index 0 (the only row left).
    const rows = [rowA]
    expect(resolveCursor(rows, 'row-c', 2)).toBe(0)
  })

  it('empty rows: returns 0 regardless of prevRowId and prevIndex', () => {
    expect(resolveCursor([], 'row-a', 5)).toBe(0)
    expect(resolveCursor([], null, 0)).toBe(0)
  })
})
