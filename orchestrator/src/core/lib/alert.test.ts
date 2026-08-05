/**
 * Tests for the Alert read aggregate (ADR-0054).
 *
 * Covers:
 *   - buildAlert for an arc-failed alert (goal → reason → technical hierarchy),
 *   - buildAlert for a stale-worktree alert,
 *   - the no-persistence guarantee: buildAlert is a pure function that never
 *     touches any store, and the list/show use-cases read only through their
 *     injected sources (no write path is ever invoked).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  buildAlert,
  listAlerts,
  showAlert,
  type AlertChainNode,
  type AlertSources,
  type FailedArcRecord,
  type StaleWorktreeRecord,
  type VerifyUncoveredRecord,
} from './alert'
import { resolveFailureKind } from './failure-kinds'
import type { FailureKind } from './failure-kinds'

describe('buildAlert', () => {
  it('builds an arc-failed alert with a goal → reason → technical hierarchy', () => {
    // A registered signature resolves to its warm FailureKind copy.
    const fk = resolveFailureKind('verify:has-diff/no-commits-ahead', '')
    const alert = buildAlert('mars-abc12345', fk, 'Error: nothing committed', {
      goal: 'Rebuild the merge gate so dirty trees are rejected',
      traceTail: 'Error: nothing committed',
      descendants: [{ id: 'fix-9f8e', status: 'failed' }],
      chain: [],
    })

    expect(alert.kind).toBe('arc-failed')
    expect(alert.arcId).toBe('mars-abc12345')
    expect(alert.goal).toBe('Rebuild the merge gate so dirty trees are rejected')
    // reason is the warm verboseReason from the registry.
    expect(alert.reason).toBe(fk.verboseReason)
    // technical carries the raw signal: signature + trace tail + chain.
    expect(alert.technical).toContain('signature: verify:has-diff/no-commits-ahead')
    expect(alert.technical).toContain('Error: nothing committed')
    expect(alert.technical).toContain('recovery chain: fix-9f8e (failed)')
  })

  it('falls back to warmTitle when verboseReason is empty', () => {
    const fk: FailureKind = {
      signature: 'verify:custom/empty-reason',
      warmTitle: 'A check did not pass',
      verboseReason: '   ',
      recipe: null,
      actions: [],
      staticEncodable: { encodable: false, reason: 'unclassified' },
    }
    const alert = buildAlert('mars-empty001', fk, '', {
      goal: 'g',
      traceTail: '',
      descendants: [],
      chain: [],
    })
    expect(alert.reason).toBe('A check did not pass')
  })

  it('builds a stale-worktree alert (kind from the signature prefix)', () => {
    const fk: FailureKind = {
      signature: 'stale-worktree/leftover',
      warmTitle: 'A leftover worktree is taking up space',
      verboseReason: 'A worktree from a terminal task is still on disk.',
      recipe: null,
      actions: [],
      staticEncodable: { encodable: false, reason: 'environmental' },
    }
    const alert = buildAlert('mars-stale999', fk, '', {
      goal: 'Add the alert read aggregate',
      traceTail: '',
      descendants: [],
      chain: [],
    })

    expect(alert.kind).toBe('stale-worktree')
    expect(alert.arcId).toBe('mars-stale999')
    expect(alert.reason).toBe('A worktree from a terminal task is still on disk.')
    // No trace, no descendants → technical is just the signature line.
    expect(alert.technical).toBe('signature: stale-worktree/leftover')
  })

  it('collapses a multi-line goal to a single readable line', () => {
    const fk = resolveFailureKind('verify:has-diff/no-commits-ahead', '')
    const alert = buildAlert('mars-multiline', fk, '', {
      goal: 'line one\n  line two\n\n  line three',
      traceTail: '',
      descendants: [],
      chain: [],
    })
    expect(alert.goal).toBe('line one line two line three')
  })

  it('surfaces goal verbatim from intent — no LLM call, no recomputation', () => {
    // Mirrors the daemon path: origin.intent is stored as FailedArcRecord.goal and
    // buildAlert must pass it through unchanged. This regression guards against any
    // layer accidentally overwriting or re-deriving the intent.
    const fk = resolveFailureKind('verify:has-diff/no-commits-ahead', '')
    const alert = buildAlert('mars-intent01', fk, '', {
      goal: 'rename foo to bar',
      traceTail: '',
      descendants: [],
      chain: [],
    })
    expect(alert.goal).toBe('rename foo to bar')
  })

  it('is pure: does not mutate its inputs and is deterministic', () => {
    const fk = resolveFailureKind('verify:has-diff/no-commits-ahead', 'boom')
    const input = {
      goal: 'goal',
      traceTail: 'boom',
      descendants: [{ id: 'fix-1', status: 'failed' }],
    }
    const frozenDescendants = Object.freeze([...input.descendants])
    const first = buildAlert('arc-1', fk, 'boom', {
      ...input,
      descendants: frozenDescendants,
      chain: [],
    })
    const second = buildAlert('arc-1', fk, 'boom', {
      ...input,
      descendants: frozenDescendants,
      chain: [],
    })
    // Same inputs → identical output (deterministic, no hidden state).
    expect(second).toEqual(first)
    // Inputs are untouched.
    expect(frozenDescendants).toEqual([{ id: 'fix-1', status: 'failed' }])
  })
})

describe('listAlerts / showAlert', () => {
  // listAlerts → alertForStaleWorktree → resolveOriginIdForTask calls
  // getDefaultTaskStore(), which requires an isolated temp store when running
  // under vitest. Set one up via the established vi.resetModules() pattern so
  // the queue client singleton picks up the hermetic MARS_REPO.
  let repo: string
  let listAlertsLocal: typeof listAlerts
  let showAlertLocal: typeof showAlert
  let buildAlertLocal: typeof buildAlert

  beforeEach(async () => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-alert-test-'))
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    vi.resetModules()
    process.env.MARS_REPO = repo
    const alertMod = await import('./alert')
    listAlertsLocal = alertMod.listAlerts
    showAlertLocal = alertMod.showAlert
    buildAlertLocal = alertMod.buildAlert
    const queueMod = await import('../queue')
    await queueMod.migrateQueueSchema()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  const failedArc: FailedArcRecord = {
    arcId: 'mars-failed01',
    goal: 'Cut the operator dismiss endpoint',
    failureSignature: 'verify:typecheck/typecheck-cannot-find-name',
    capturedError: 'TS2304: Cannot find name foo',
    traceTail: 'TS2304: Cannot find name foo',
    descendants: [{ id: 'fix-aaaa', status: 'failed' }],
    chain: [
      { kind: 'task', id: 'mars-failed01', status: 'failed', label: 'Cut the operator dismiss endpoint', attemptIndex: 1 },
    ],
  }

  const staleRecord: StaleWorktreeRecord = {
    taskId: 'mars-failed01',
    prompt: 'leftover work',
    status: 'absent (no matching task)',
    ageHours: 26,
  }

  const uncoveredRecord: VerifyUncoveredRecord = {
    fingerprint: 'coverage:src/widgets',
    recipe: 'add-verify-gate',
    scope: 'src/widgets',
    changedPaths: ['src/widgets/BellMenu.tsx', 'src/widgets/BellMenu.test.tsx'],
  }

  it('lists alerts for failed arcs and stale worktrees', async () => {
    const sources: AlertSources = {
      listFailedArcs: vi.fn(async () => [failedArc]),
      listStaleWorktrees: vi.fn(async () => [staleRecord]),
      listVerifyUncovered: vi.fn(async () => []),
    }
    const alerts = await listAlertsLocal(sources)

    expect(alerts).toHaveLength(2)
    const arcAlert = alerts.find((a) => a.kind === 'arc-failed')
    const staleAlert = alerts.find((a) => a.kind === 'stale-worktree')
    expect(arcAlert?.arcId).toBe('mars-failed01')
    expect(arcAlert?.goal).toBe('Cut the operator dismiss endpoint')
    expect(arcAlert?.technical).toContain(
      'signature: verify:typecheck/typecheck-cannot-find-name',
    )
    expect(staleAlert).toBeTruthy()
    // Both read sources were consulted; nothing else.
    expect(sources.listFailedArcs).toHaveBeenCalledTimes(1)
    expect(sources.listStaleWorktrees).toHaveBeenCalledTimes(1)
  })

  it('lists each open uncovered verify scope with its CAN\'T-VERIFY evidence', async () => {
    const sources: AlertSources = {
      listFailedArcs: async () => [],
      listStaleWorktrees: async () => [],
      listVerifyUncovered: async () => [uncoveredRecord],
    }

    const [alert] = await listAlertsLocal(sources)

    expect(alert).toMatchObject({
      arcId: 'coverage:src/widgets',
      kind: 'verify-uncovered',
      goal: 'src/widgets',
      reason: "CAN'T-VERIFY: no task-tier verify gate covers the changed files",
      fingerprint: 'coverage:src/widgets',
      recipe: 'add-verify-gate',
    })
    expect(alert?.technical).toContain('src/widgets/BellMenu.tsx')
    expect(alert?.technical).toContain('src/widgets/BellMenu.test.tsx')

    await expect(
      showAlertLocal('coverage:src/widgets', sources),
    ).resolves.toMatchObject({ kind: 'verify-uncovered' })
  })

  it('showAlert returns the matching arc alert, or null on a miss', async () => {
    const sources: AlertSources = {
      listFailedArcs: async () => [failedArc],
      listStaleWorktrees: async () => [],
      listVerifyUncovered: async () => [],
    }
    const hit = await showAlertLocal('mars-failed01', sources)
    expect(hit?.arcId).toBe('mars-failed01')
    expect(hit?.kind).toBe('arc-failed')

    const miss = await showAlertLocal('mars-does-not-exist', sources)
    expect(miss).toBeNull()
  })

  it('no-persistence guarantee: never writes to action_queue_items', async () => {
    // Spy on the action-queue write path. The Alert aggregate is a pure read
    // derivation (ADR-0054) — building / listing / showing an alert must never
    // raise or mutate an action_queue_items row.
    const actionQueue = await import('./action-queue')
    const raiseSpy = vi.spyOn(actionQueue, 'raiseActionQueueItem')

    const sources: AlertSources = {
      listFailedArcs: async () => [failedArc],
      listStaleWorktrees: async () => [staleRecord],
      listVerifyUncovered: async () => [],
    }
    buildAlertLocal(
      'arc-x',
      resolveFailureKind('verify:has-diff/no-commits-ahead', ''),
      'tail',
      { goal: 'g', traceTail: 'tail', descendants: [], chain: [] },
    )
    await listAlertsLocal(sources)
    await showAlertLocal('mars-failed01', sources)

    expect(raiseSpy).not.toHaveBeenCalled()
    raiseSpy.mockRestore()
  })
})

describe('Alert chain field', () => {
  it('full chain: proposal head + 3 attempts flows through buildAlert verbatim', () => {
    const fk = resolveFailureKind('verify:has-diff/no-commits-ahead', '')
    const chain: AlertChainNode[] = [
      { kind: 'proposal', id: 'prop-a1b2c3d4', status: 'sliced', label: 'Add the merge gate' },
      { kind: 'task', id: 'mars-t0001', status: 'failed', label: 'Add the merge gate', attemptIndex: 1 },
      { kind: 'task', id: 'mars-t0002', status: 'failed', label: 'Add the merge gate', attemptIndex: 2 },
      { kind: 'task', id: 'mars-t0003', status: 'failed', label: 'Add the merge gate', attemptIndex: 3 },
    ]

    const alert = buildAlert('mars-t0001', fk, '', {
      goal: 'Add the merge gate',
      traceTail: '',
      descendants: [],
      chain,
    })

    expect(alert.chain).toEqual(chain)
    expect(alert.chain).toHaveLength(4)
    expect(alert.chain[0].kind).toBe('proposal')
    expect(alert.chain[0].id).toBe('prop-a1b2c3d4')
    expect(alert.chain[1].kind).toBe('task')
    expect(alert.chain[1].attemptIndex).toBe(1)
    expect(alert.chain[2].attemptIndex).toBe(2)
    expect(alert.chain[3].attemptIndex).toBe(3)
  })

  it('lone-task fallback: chain is a single task node with no synthetic "No origin" node', () => {
    const fk = resolveFailureKind('verify:has-diff/no-commits-ahead', '')
    const chain: AlertChainNode[] = [
      { kind: 'task', id: 'mars-lone01', status: 'failed', label: 'Lone task with no proposal', attemptIndex: 1 },
    ]

    const alert = buildAlert('mars-lone01', fk, '', {
      goal: 'Lone task with no proposal',
      traceTail: '',
      descendants: [],
      chain,
    })

    expect(alert.chain).toHaveLength(1)
    expect(alert.chain[0].kind).toBe('task')
    expect(alert.chain[0].id).toBe('mars-lone01')
    expect(alert.chain[0].attemptIndex).toBe(1)
    // No synthetic 'No origin recorded' node
    expect(alert.chain.every((n) => !n.label.includes('No origin'))).toBe(true)
  })
})
