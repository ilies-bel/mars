import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

interface InboxModule {
  raiseInboxItem: typeof import('./inbox').raiseInboxItem
  listInboxItems: typeof import('./inbox').listInboxItems
  getInboxItem: typeof import('./inbox').getInboxItem
  setInboxState: typeof import('./inbox').setInboxState
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-inbox-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModule = async (repo: string): Promise<InboxModule> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  return (await import('./inbox')) as unknown as InboxModule
}

const baseItem = (overrides: Partial<Parameters<InboxModule['raiseInboxItem']>[0]> = {}) => ({
  kind: 'worktree_cleanup_failed',
  category: 'orchestrator' as const,
  priority: 'normal' as const,
  title: 'Worktree cleanup failed',
  body: 'Could not remove worktree',
  payload: {},
  context: { task_id: 'abc123' },
  raisedBy: 'orchestrator:merge-step',
  signature: 'sig-1',
  ...overrides,
})

describe('inbox', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('inserts a new item with seen_count=1, state=open, fingerprint=sha1(kind:signature)', async () => {
    const inbox = await loadModule(repo)
    const id = await inbox.raiseInboxItem(
      baseItem({ occurrence: { task_id: 'abc123', stderr_tail: 'EPERM' } }),
    )
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)

    const item = await inbox.getInboxItem(id)
    expect(item).not.toBeNull()
    expect(item!.id).toBe(id)
    expect(item!.kind).toBe('worktree_cleanup_failed')
    expect(item!.state).toBe('open')
    expect(item!.seenCount).toBe(1)
    expect(item!.raisedBy).toBe('orchestrator:merge-step')
    expect(item!.context).toEqual({ task_id: 'abc123' })
    expect(item!.payload.occurrences).toEqual([
      { task_id: 'abc123', stderr_tail: 'EPERM' },
    ])
    expect(item!.fingerprint).toMatch(/^[a-f0-9]{40}$/)
    expect(item!.raisedAt).toBe(item!.lastSeenAt)
    expect(item!.resolvedAt).toBeNull()
  })

  it('dedups by fingerprint: bumps seen_count and appends occurrences', async () => {
    const inbox = await loadModule(repo)
    const first = await inbox.raiseInboxItem(
      baseItem({ occurrence: { task_id: 't1' } }),
    )
    const second = await inbox.raiseInboxItem(
      baseItem({ occurrence: { task_id: 't2' } }),
    )
    const third = await inbox.raiseInboxItem(
      baseItem({ occurrence: { task_id: 't3' } }),
    )
    expect(second).toBe(first)
    expect(third).toBe(first)

    const item = await inbox.getInboxItem(first)
    expect(item!.seenCount).toBe(3)
    expect(item!.payload.occurrences).toEqual([
      { task_id: 't1' },
      { task_id: 't2' },
      { task_id: 't3' },
    ])
    expect(item!.lastSeenAt >= item!.raisedAt).toBe(true)
  })

  it('different signature -> distinct item', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(baseItem({ signature: 'sig-a' }))
    const b = await inbox.raiseInboxItem(baseItem({ signature: 'sig-b' }))
    expect(a).not.toBe(b)
    const all = await inbox.listInboxItems('open')
    expect(all).toHaveLength(2)
  })

  it('getInboxItem returns null on unknown id', async () => {
    const inbox = await loadModule(repo)
    const result = await inbox.getInboxItem('does-not-exist')
    expect(result).toBeNull()
  })

  it('listInboxItems filters by state and supports "all"', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(baseItem({ signature: 'a' }))
    const b = await inbox.raiseInboxItem(baseItem({ signature: 'b' }))
    await inbox.raiseInboxItem(baseItem({ signature: 'c' }))

    await inbox.setInboxState(a, 'resolved', { resolution: 'fixed' })
    await inbox.setInboxState(b, 'dismissed')

    const open = await inbox.listInboxItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].state).toBe('open')

    const resolved = await inbox.listInboxItems('resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0].id).toBe(a)

    const dismissed = await inbox.listInboxItems('dismissed')
    expect(dismissed).toHaveLength(1)
    expect(dismissed[0].id).toBe(b)

    const all = await inbox.listInboxItems('all')
    expect(all).toHaveLength(3)
  })

  it('listInboxItems filters by kind across any state', async () => {
    const inbox = await loadModule(repo)
    await inbox.raiseInboxItem(
      baseItem({ kind: 'recovery-failed', signature: 'rf-1' }),
    )
    await inbox.raiseInboxItem(
      baseItem({ kind: 'recovery-failed', signature: 'rf-2' }),
    )
    await inbox.raiseInboxItem(
      baseItem({ kind: 'no-recipe', signature: 'nr-1' }),
    )

    const recoveryFailed = await inbox.listInboxItems('open', {
      kind: 'recovery-failed',
    })
    expect(recoveryFailed).toHaveLength(2)
    for (const item of recoveryFailed) {
      expect(item.kind).toBe('recovery-failed')
    }

    const noRecipe = await inbox.listInboxItems('open', { kind: 'no-recipe' })
    expect(noRecipe).toHaveLength(1)
    expect(noRecipe[0].kind).toBe('no-recipe')

    const noMatch = await inbox.listInboxItems('open', { kind: 'nope' })
    expect(noMatch).toHaveLength(0)

    // Combining state filter and kind filter still narrows correctly.
    const openAll = await inbox.listInboxItems('open')
    expect(openAll).toHaveLength(3)
  })

  it('setInboxState transitions to resolved and persists resolution + note + rootCause', async () => {
    const inbox = await loadModule(repo)
    const id = await inbox.raiseInboxItem(baseItem())
    await inbox.setInboxState(id, 'resolved', {
      resolution: 'fixed',
      note: 'manual cleanup ran',
      rootCause: 'stale lock from crashed daemon',
    })
    const item = await inbox.getInboxItem(id)
    expect(item!.state).toBe('resolved')
    expect(item!.resolution).toBe('fixed')
    expect(item!.resolutionNote).toBe('manual cleanup ran')
    expect(item!.rootCause).toBe('stale lock from crashed daemon')
    expect(item!.resolvedAt).not.toBeNull()
  })

  it('setInboxState acknowledged does not set resolved_at', async () => {
    const inbox = await loadModule(repo)
    const id = await inbox.raiseInboxItem(baseItem())
    await inbox.setInboxState(id, 'acknowledged')
    const item = await inbox.getInboxItem(id)
    expect(item!.state).toBe('acknowledged')
    expect(item!.resolvedAt).toBeNull()
  })

  it('setInboxState is idempotent on the same terminal state', async () => {
    const inbox = await loadModule(repo)
    const id = await inbox.raiseInboxItem(baseItem())
    await inbox.setInboxState(id, 'resolved', { resolution: 'fixed' })
    const first = await inbox.getInboxItem(id)
    const firstResolvedAt = first!.resolvedAt

    await new Promise((r) => setTimeout(r, 5))
    await inbox.setInboxState(id, 'resolved')
    const second = await inbox.getInboxItem(id)
    expect(second!.state).toBe('resolved')
    expect(second!.resolution).toBe('fixed')
    expect(second!.resolvedAt).not.toBeNull()
    expect(second!.resolvedAt! >= firstResolvedAt!).toBe(true)
  })

  it('setInboxState on unknown id is a no-op', async () => {
    const inbox = await loadModule(repo)
    await expect(
      inbox.setInboxState('nonexistent', 'resolved'),
    ).resolves.toBeUndefined()
  })

  it('originTaskId collapses N failures across kinds/signatures into exactly one open row', async () => {
    const inbox = await loadModule(repo)
    const originId = 'origin-1'

    // Simulate 11 failures on the same origin, across kinds and
    // signatures (no-recipe on first failure, recovery-failed on each
    // subsequent recovery attempt, eventually a fix-fail-loop).
    const ids = [
      await inbox.raiseInboxItem(
        baseItem({
          kind: 'no-recipe',
          signature: 'sig-A',
          originTaskId: originId,
          occurrence: { attempt: 1 },
        }),
      ),
    ]
    for (let i = 2; i <= 10; i += 1) {
      ids.push(
        await inbox.raiseInboxItem(
          baseItem({
            kind: 'recovery-failed',
            signature: `origin-1:sig-${i}`,
            originTaskId: originId,
            occurrence: { attempt: i },
          }),
        ),
      )
    }
    ids.push(
      await inbox.raiseInboxItem(
        baseItem({
          kind: 'fix-fail-loop',
          signature: 'sig-Z',
          originTaskId: originId,
          occurrence: { attempt: 11 },
        }),
      ),
    )

    // Every raise returns the SAME row id.
    for (const id of ids) {
      expect(id).toBe(ids[0])
    }

    const open = await inbox.listInboxItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(ids[0])
    expect(open[0].seenCount).toBe(11)
    expect(open[0].payload.occurrences).toHaveLength(11)
  })

  it('originTaskId is independent of fingerprint: a different origin still produces a distinct row', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(
      baseItem({
        kind: 'recovery-failed',
        signature: 'shared-sig',
        originTaskId: 'origin-A',
      }),
    )
    const b = await inbox.raiseInboxItem(
      baseItem({
        kind: 'recovery-failed',
        signature: 'shared-sig',
        originTaskId: 'origin-B',
      }),
    )
    expect(a).not.toBe(b)
    const open = await inbox.listInboxItems('open')
    expect(open).toHaveLength(2)
  })

  it('omitting originTaskId falls back to (kind, signature) dedup', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(baseItem({ signature: 'legacy' }))
    const b = await inbox.raiseInboxItem(baseItem({ signature: 'legacy' }))
    expect(b).toBe(a)
  })

  it('after resolving an item, raising the same fingerprint creates a new open item (only open is dedup target)', async () => {
    const inbox = await loadModule(repo)
    const a = await inbox.raiseInboxItem(baseItem())
    await inbox.setInboxState(a, 'resolved', { resolution: 'fixed' })
    const b = await inbox.raiseInboxItem(baseItem())
    expect(b).not.toBe(a)
    const open = await inbox.listInboxItems('open')
    expect(open).toHaveLength(1)
    expect(open[0].id).toBe(b)
    expect(open[0].seenCount).toBe(1)
  })
})
