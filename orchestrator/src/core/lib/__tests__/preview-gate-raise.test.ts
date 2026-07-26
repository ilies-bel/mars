/**
 * Projection tests for the awaiting-validation action-queue row raised by
 * the merge-primitive preview gate.
 *
 * Bug: when `startDevServer` threw during a preview gate, the code path
 * silently caught the error and skipped the `raiseActionQueueItem` call,
 * leaving the task parked in `awaiting-validation` with NO open row.
 * The operator had no way to discover the task without reading the DB
 * directly.
 *
 * Fix: the boot-failure catch block now calls `updateTask` (parks the task)
 * then `raiseActionQueueItem` with a "preview failed to boot" title before
 * throwing the terminal error sentinel — exactly mirroring the success path.
 *
 * These tests verify the projection (what the action-queue looks like after
 * the raise) for both paths:
 *   1. Happy path: dev server boots → open row carries the preview URL.
 *   2. Boot failure: dev server throws → open row says "preview failed to boot".
 *
 * Both paths use the same raise mechanism (`raiseActionQueueItem` with
 * `kind='awaiting-validation'`, `signature='${taskId}:awaiting-validation'`)
 * so we assert that directly rather than plumbing through the full merge
 * primitive (which requires a real git worktree and worker context).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// PGlite cold start can take >5 s; raise both timeouts to 30 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

let repo: string
let actionQueue: typeof import('../action-queue')

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-preview-raise-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })

  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = await import('../../queue')
  await q.migrateQueueSchema()
  actionQueue = await import('../action-queue')
  await actionQueue.initActionQueue()
})

afterAll(() => {
  delete process.env.MARS_REPO
  vi.resetModules()
  rmSync(repo, { recursive: true, force: true })
})

describe('preview-gate projection — awaiting-validation row raise', () => {
  it('happy path: row is open with the preview URL in the title', async () => {
    const taskId = `mars-test-${Math.random().toString(36).slice(2, 8)}`
    const url = 'http://127.0.0.1:5555'

    // Simulate what the merge primitive does on a successful dev server boot.
    await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-validation',
      category: 'user',
      priority: 'high',
      title: `Validate ${taskId}: preview running at ${url}`,
      body: 'Preview is running. Click Validate or Reject.',
      payload: { taskId, devServerUrl: url, devServerPid: 4242, integrationBranch: 'main', branch: `task/${taskId}` },
      context: { repoRoot: null },
      raisedBy: 'merge:preview-gate',
      signature: `${taskId}:awaiting-validation`,
      originTaskId: taskId,
      occurrence: { at: new Date().toISOString(), taskId, devServerUrl: url },
    })

    const open = await actionQueue.listActionQueueItems('open')
    const row = open.find((i) => i.payload['taskId'] === taskId)

    expect(row, 'awaiting-validation row must be open after successful boot').toBeDefined()
    expect(row!.kind).toBe('awaiting-validation')
    expect(row!.title).toContain(url)
    expect(row!.state).toBe('open')
  })

  it('boot-failure path: row is open with "preview failed to boot" in the title', async () => {
    const taskId = `mars-test-${Math.random().toString(36).slice(2, 8)}`
    const bootError = new Error('ENOENT: npm run dev: command not found')

    // Simulate what the merge primitive does when startDevServer throws.
    await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-validation',
      category: 'user',
      priority: 'high',
      title: `Validate ${taskId}: preview failed to boot`,
      body: [
        `Task \`${taskId}\` passed verify, but its preview server failed to start.`,
        '',
        `Boot error: ${bootError.message}`,
      ].join('\n'),
      payload: { taskId, devServerUrl: null, devServerPid: null, integrationBranch: 'main', branch: `task/${taskId}` },
      context: { repoRoot: null },
      raisedBy: 'merge:preview-gate',
      signature: `${taskId}:awaiting-validation`,
      originTaskId: taskId,
      occurrence: { at: new Date().toISOString(), taskId, devServerUrl: null },
    })

    const open = await actionQueue.listActionQueueItems('open')
    const row = open.find((i) => i.payload['taskId'] === taskId)

    expect(row, 'awaiting-validation row must be open even when dev server fails to boot').toBeDefined()
    expect(row!.kind).toBe('awaiting-validation')
    expect(row!.title).toContain('preview failed to boot')
    expect(row!.state).toBe('open')
    // No URL in the boot-failure row — operator knows not to expect a live server.
    expect(row!.payload['devServerUrl']).toBeNull()
  })

  it('level-triggered: raising twice for the same task produces exactly one open row', async () => {
    const taskId = `mars-test-${Math.random().toString(36).slice(2, 8)}`
    const sig = `${taskId}:awaiting-validation`

    // First raise (e.g. boot failed).
    await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-validation',
      category: 'user',
      priority: 'high',
      title: `Validate ${taskId}: preview failed to boot`,
      body: 'boot failed',
      payload: { taskId },
      context: {},
      raisedBy: 'merge:preview-gate',
      signature: sig,
      originTaskId: taskId,
    })

    // Second raise with same task id deduplicates: bumps seen_count, does not
    // create a second open row. This is the level-triggered ADR-0048 behaviour —
    // the action queue never has two open rows for the same origin task.
    await actionQueue.raiseActionQueueItem({
      kind: 'awaiting-validation',
      category: 'user',
      priority: 'high',
      title: `Validate ${taskId}: preview failed to boot`,
      body: 'boot failed (second attempt)',
      payload: { taskId },
      context: {},
      raisedBy: 'merge:preview-gate',
      signature: sig,
      originTaskId: taskId,
    })

    const open = await actionQueue.listActionQueueItems('open')
    const rows = open.filter((i) => i.payload['taskId'] === taskId)

    // Exactly one open row — level-triggered deduplication.
    expect(rows.length, 'exactly one open row per task even after two raises').toBe(1)
  })
})
