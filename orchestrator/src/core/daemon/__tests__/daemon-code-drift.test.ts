/**
 * Tests for the level-triggered `daemon-code-drift` action-queue row.
 *
 * Acceptance criteria (from task brief):
 *  - synthetic drift (sourceSha ≠ HEAD sha) → exactly one open row raised
 *  - idempotent: raising again (second staleness tick) still exactly one row
 *  - cleared/re-evaluated after restart (supersedeActionQueueItemsBySignature)
 *
 * Tests exercise the public action-queue API that the staleness interval and
 * the startup reconciler both use — no coupling to server.ts internals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface ActionQueueModule {
  raiseActionQueueItem: typeof import('../../lib/action-queue').raiseActionQueueItem
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
  supersedeActionQueueItemsBySignature: typeof import('../../lib/action-queue').supersedeActionQueueItemsBySignature
  getActionQueueItem: typeof import('../../lib/action-queue').getActionQueueItem
}

interface QueueModule {
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-code-drift-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<{ actionQueue: ActionQueueModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const actionQueue = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  return { actionQueue }
}

/** Simulate what the staleness interval does when drift is detected. */
const raiseDrift = async (
  actionQueue: ActionQueueModule,
  sourceSha = 'abc1234abc1234abc1234abc1234abc1234abc1234',
  headSha = 'def5678def5678def5678def5678def5678def5678',
): Promise<string> => {
  const shortSrc = sourceSha.slice(0, 7)
  const shortHead = headSha.slice(0, 7)
  return actionQueue.raiseActionQueueItem({
    kind: 'daemon-code-drift',
    category: 'daemon',
    priority: 'high',
    title: `Daemon running stale code — ${shortSrc} → ${shortHead}`,
    body:
      `daemon running ${shortSrc}, main is at ${shortHead} — ` +
      `run \`mars daemon restart\` to load current verify/dispatch code`,
    payload: { sourceSha, currentSha: headSha },
    context: {},
    raisedBy: 'daemon:dev-staleness-check',
    signature: 'daemon-code-drift',
    occurrence: { detectedAt: new Date().toISOString() },
  })
}

describe('daemon-code-drift action-queue rows', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: drift detected → exactly one open row ──────────────────

  it('raises exactly one open daemon-code-drift row when drift is detected', async () => {
    const { actionQueue } = await loadModules(repo)

    await raiseDrift(actionQueue)

    const open = await actionQueue.listActionQueueItems('open')
    const driftRows = open.filter((i) => i.kind === 'daemon-code-drift')
    expect(driftRows).toHaveLength(1)
    expect(driftRows[0]?.state).toBe('open')
  })

  // ── Idempotent: second staleness tick does NOT create a second row ─────────

  it('is idempotent: raising again bumps seen_count but keeps exactly one open row', async () => {
    const { actionQueue } = await loadModules(repo)

    const id1 = await raiseDrift(actionQueue)
    const id2 = await raiseDrift(actionQueue)

    // Same row id returned both times (dedup by kind+signature fingerprint)
    expect(id1).toBe(id2)

    const open = await actionQueue.listActionQueueItems('open')
    const driftRows = open.filter((i) => i.kind === 'daemon-code-drift')
    expect(driftRows).toHaveLength(1)
  })

  // ── Restart clears the row ────────────────────────────────────────────────

  it('resolves the open drift row when supersedeActionQueueItemsBySignature is called (simulates restart)', async () => {
    const { actionQueue } = await loadModules(repo)

    const id = await raiseDrift(actionQueue)

    // Verify the row is open before the simulated restart
    const beforeRestart = await actionQueue.getActionQueueItem(id)
    expect(beforeRestart?.state).toBe('open')

    // Simulate the startup reconciler clearing the row
    const cleared = await actionQueue.supersedeActionQueueItemsBySignature(
      'daemon-code-drift',
      'daemon-code-drift',
      'daemon-restarted',
      'daemon:restart',
    )
    expect(cleared).toHaveLength(1)
    expect(cleared[0]).toBe(id)

    const afterRestart = await actionQueue.getActionQueueItem(id)
    expect(afterRestart?.state).toBe('resolved')
  })

  // ── After restart, fresh drift can raise a new row ────────────────────────

  it('allows a new drift row after the old one is cleared (new daemon cycle)', async () => {
    const { actionQueue } = await loadModules(repo)

    // "Old daemon" raises a drift row
    const oldId = await raiseDrift(actionQueue, 'abc1234abc1234abc1234abc1234abc1234abc1234', 'def5678def5678def5678def5678def5678def5678')

    // "Daemon restart" — clear the stale row
    await actionQueue.supersedeActionQueueItemsBySignature(
      'daemon-code-drift',
      'daemon-code-drift',
      'daemon-restarted',
      'daemon:restart',
    )

    // "New daemon" runs for a while and detects drift again (different sha pair)
    const newId = await raiseDrift(actionQueue, 'def5678def5678def5678def5678def5678def5678', 'ghi9012ghi9012ghi9012ghi9012ghi9012ghi9012')

    // A fresh row was created — different id from the old one
    expect(newId).not.toBe(oldId)

    const open = await actionQueue.listActionQueueItems('open')
    const driftRows = open.filter((i) => i.kind === 'daemon-code-drift')
    expect(driftRows).toHaveLength(1)
    expect(driftRows[0]?.id).toBe(newId)
  })

  // ── No row when there is no drift ────────────────────────────────────────

  it('raises no row when there is no drift (baseline)', async () => {
    const { actionQueue } = await loadModules(repo)

    // No call to raiseDrift — simulates a fresh daemon with no drift

    const open = await actionQueue.listActionQueueItems('open')
    const driftRows = open.filter((i) => i.kind === 'daemon-code-drift')
    expect(driftRows).toHaveLength(0)
  })

  // ── Clear is a no-op when no drift row exists ─────────────────────────────

  it('supersedeActionQueueItemsBySignature is a no-op when no drift row is open', async () => {
    const { actionQueue } = await loadModules(repo)

    const cleared = await actionQueue.supersedeActionQueueItemsBySignature(
      'daemon-code-drift',
      'daemon-code-drift',
      'daemon-restarted',
      'daemon:restart',
    )
    expect(cleared).toHaveLength(0)
  })
})
