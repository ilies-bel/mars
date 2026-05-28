/**
 * Slice F.2 inbox-side tests:
 *  - aggregated inbox row on committer failure lists every blocked dependent.
 *  - on committer success, stale failed-committer inbox rows (at a DIFFERENT
 *    hash) get superseded.
 *
 * Pattern follows the existing F.1 blocker-invariant tests: a temp repo and
 * a per-test reset of the queue/inbox singletons via `vi.resetModules()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-main-dirty-inbox-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const noopLog = (): void => {}

describe('raiseAggregatedMainCommiterFailureRow', () => {
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

  it('lists every blocked dependent in the body and titles the cohort count', async () => {
    const queue = await import('../../queue')
    await queue.initQueue()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()

    const src1 = await queue.enqueueTask('first dependent', undefined, {
      skipTriage: true,
    })
    const src2 = await queue.enqueueTask('second dependent', undefined, {
      skipTriage: true,
    })

    const detection = { dirty: true as const, hash: 'aa'.repeat(32), statusOutput: '' }
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src1.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src1.id,
      traceStore: nullTraceStore,
    })
    await spawnOrAttachMainCommitter({
      sourceTaskId: src2.id,
      detection,
      integrationBranch: 'main',
      dispatchPhase: 'verify',
      recipePrompt: 'p',
      sourceOriginId: src2.id,
      traceStore: nullTraceStore,
    })

    const { raiseAggregatedMainCommiterFailureRow } = await import(
      '../main-dirty-inbox'
    )
    const inboxItemId = await raiseAggregatedMainCommiterFailureRow(
      resolution.fixTaskId,
      noopLog,
    )
    expect(inboxItemId).toBeTruthy()

    const inbox = await import('../../lib/inbox')
    const item = await inbox.getInboxItem(inboxItemId!)
    expect(item).not.toBeNull()
    expect(item!.kind).toBe('failed')
    expect(item!.priority).toBe('high')
    expect(item!.title).toMatch(/2 tasks blocked/)
    expect(item!.body).toContain(src1.id)
    expect(item!.body).toContain(src2.id)
    expect(item!.body).toContain('first dependent')
    expect(item!.body).toContain('second dependent')
  })

  it('handles a committer with zero current dependents (cleared by other paths)', async () => {
    const queue = await import('../../queue')
    await queue.initQueue()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()
    const src = await queue.enqueueTask('a', undefined, { skipTriage: true })
    const resolution = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, hash: 'bb'.repeat(32), statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    // Simulate the dependent being unblocked by another path: drop the edge.
    const c = queue.getClient()
    await c.execute({
      sql: `DELETE FROM task_blockers WHERE blocker_task_id = ?`,
      args: [resolution.fixTaskId],
    })

    const { raiseAggregatedMainCommiterFailureRow } = await import(
      '../main-dirty-inbox'
    )
    const id = await raiseAggregatedMainCommiterFailureRow(
      resolution.fixTaskId,
      noopLog,
    )
    expect(id).toBeTruthy()
    const inbox = await import('../../lib/inbox')
    const item = await inbox.getInboxItem(id!)
    expect(item!.title).toMatch(/no tasks currently blocked/i)
  })
})

describe('sweepStaleFailedMainCommiterInbox', () => {
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

  it('supersedes inbox rows for previously-failed committers at DIFFERENT hashes', async () => {
    const queue = await import('../../queue')
    await queue.initQueue()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()
    // Old failed committer at hash A.
    const oldSrc = await queue.enqueueTask('old', undefined, {
      skipTriage: true,
    })
    const old = await spawnOrAttachMainCommitter({
      sourceTaskId: oldSrc.id,
      detection: { dirty: true, hash: 'a'.repeat(64), statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: oldSrc.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(old.fixTaskId, {
      status: 'failed',
      error: 'old committer failed',
    })
    const { raiseAggregatedMainCommiterFailureRow } = await import(
      '../main-dirty-inbox'
    )
    const oldInboxId = await raiseAggregatedMainCommiterFailureRow(
      old.fixTaskId,
      noopLog,
    )
    expect(oldInboxId).toBeTruthy()

    // Fresh committer succeeds at hash B.
    const newSrc = await queue.enqueueTask('new', undefined, {
      skipTriage: true,
    })
    const fresh = await spawnOrAttachMainCommitter({
      sourceTaskId: newSrc.id,
      detection: { dirty: true, hash: 'b'.repeat(64), statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: newSrc.id,
      traceStore: nullTraceStore,
    })

    const { sweepStaleFailedMainCommiterInbox } = await import(
      '../main-dirty-inbox'
    )
    await sweepStaleFailedMainCommiterInbox(
      'b'.repeat(64),
      fresh.fixTaskId,
      noopLog,
    )

    const inbox = await import('../../lib/inbox')
    const item = await inbox.getInboxItem(oldInboxId!)
    expect(item!.state).toBe('resolved')
  })

  it('leaves an inbox row alone when its hash matches the fresh hash', async () => {
    const queue = await import('../../queue')
    await queue.initQueue()
    const { spawnOrAttachMainCommitter, nullTraceStore } = await (async () => {
      const m = await import('../../lib/main-dirty')
      const r = await import('../../lib/run-tool')
      return { ...m, nullTraceStore: r.nullTraceStore }
    })()
    const src = await queue.enqueueTask('same-hash', undefined, {
      skipTriage: true,
    })
    const c = await spawnOrAttachMainCommitter({
      sourceTaskId: src.id,
      detection: { dirty: true, hash: 'c'.repeat(64), statusOutput: '' },
      integrationBranch: 'main',
      dispatchPhase: 'dispatch',
      recipePrompt: 'p',
      sourceOriginId: src.id,
      traceStore: nullTraceStore,
    })
    await queue.updateTask(c.fixTaskId, {
      status: 'failed',
      error: 'committer failed',
    })
    const { raiseAggregatedMainCommiterFailureRow } = await import(
      '../main-dirty-inbox'
    )
    const inboxId = await raiseAggregatedMainCommiterFailureRow(
      c.fixTaskId,
      noopLog,
    )
    expect(inboxId).toBeTruthy()

    const { sweepStaleFailedMainCommiterInbox } = await import(
      '../main-dirty-inbox'
    )
    // Sweep with the SAME hash — must NOT resolve the row.
    await sweepStaleFailedMainCommiterInbox(
      'c'.repeat(64),
      'unrelated-fresh',
      noopLog,
    )

    const inbox = await import('../../lib/inbox')
    const item = await inbox.getInboxItem(inboxId!)
    expect(item!.state).toBe('open')
  })
})
