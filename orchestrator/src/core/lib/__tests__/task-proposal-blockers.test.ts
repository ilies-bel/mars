import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  addProposalBlockers: typeof import('../../queue').addProposalBlockers
  listProposalBlockers: typeof import('../../queue').listProposalBlockers
  removeProposalBlocker: typeof import('../../queue').removeProposalBlocker
  listTasksBlockedByProposal: typeof import('../../queue').listTasksBlockedByProposal
  transferProposalBlockerToTask: typeof import('../../queue').transferProposalBlockerToTask
  listBlockers: typeof import('../../queue').listBlockers
  hasIncompleteBlockers: typeof import('../../queue').hasIncompleteBlockers
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface Proposals {
  createProposal: typeof import('../../proposals').createProposal
  dismissProposal: typeof import('../../proposals').dismissProposal
  deleteProposal: typeof import('../../proposals').deleteProposal
  getProposal: typeof import('../../proposals').getProposal
  initProposals: typeof import('../../proposals').initProposals
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-task-prop-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const load = async (
  repo: string,
): Promise<{ q: Queue; p: Proposals }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = await import('../../queue')
  const p = await import('../../proposals')
  await q.migrateQueueSchema()
  await p.initProposals()
  return { q: q as unknown as Queue, p: p as unknown as Proposals }
}

describe('task_proposal_blockers (ADR-0015 task->idea cross-graph edge)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('adds a task->idea edge and lists it back', async () => {
    const { q, p } = await load(repo)
    const t = await q.enqueueTask('do thing')
    const idea = await p.createProposal('shape this first')
    await q.addProposalBlockers(t.id, [idea.id])
    expect(await q.listProposalBlockers(t.id)).toEqual([idea.id])
    expect(await q.listTasksBlockedByProposal(idea.id)).toEqual([t.id])
  })

  it('addProposalBlockers is idempotent and de-dups', async () => {
    const { q, p } = await load(repo)
    const t = await q.enqueueTask('do thing')
    const idea = await p.createProposal('idea')
    await q.addProposalBlockers(t.id, [idea.id, idea.id])
    await q.addProposalBlockers(t.id, [idea.id])
    expect(await q.listProposalBlockers(t.id)).toEqual([idea.id])
  })

  it('rejects when the task id does not exist', async () => {
    const { q, p } = await load(repo)
    const idea = await p.createProposal('idea')
    await expect(
      q.addProposalBlockers('nonexistent-task', [idea.id]),
    ).rejects.toThrow(/task nonexistent-task not found/)
  })

  it('removeProposalBlocker removes one edge, reports removed:false otherwise', async () => {
    const { q, p } = await load(repo)
    const t = await q.enqueueTask('do thing')
    const i1 = await p.createProposal('i1')
    const i2 = await p.createProposal('i2')
    await q.addProposalBlockers(t.id, [i1.id, i2.id])
    const r1 = await q.removeProposalBlocker(t.id, i1.id)
    expect(r1.removed).toBe(true)
    expect(await q.listProposalBlockers(t.id)).toEqual([i2.id])
    const r2 = await q.removeProposalBlocker(t.id, i1.id)
    expect(r2.removed).toBe(false)
  })

  it('promote transfer preserves the never-observably-zero-blockers invariant', async () => {
    const { q, p } = await load(repo)
    const dependent = await q.enqueueTask('dependent work')
    const idea = await p.createProposal('blocking idea')
    await q.addProposalBlockers(dependent.id, [idea.id])
    // Before transfer: gated by the idea (task->idea), not yet by a task.
    expect(await q.hasIncompleteBlockers(dependent.id)).toBe(false)
    expect(await q.listProposalBlockers(dependent.id)).toEqual([idea.id])

    // The slicer produces a real task; the transfer re-points the
    // dependent at it. Both writes (task_blockers insert,
    // task_proposal_blockers delete) are one mars.db transaction.
    const newBlocker = await q.enqueueTask('sliced from idea')
    const { transferred } = await q.transferProposalBlockerToTask(
      idea.id,
      newBlocker.id,
    )
    expect(transferred).toEqual([dependent.id])

    // After transfer: the idea edge is gone, a task_blockers edge exists,
    // and the dependent is gated by the new blocker task. At no observable
    // point did the dependent have zero blockers (the batch is atomic and
    // statement order inserts the task_blockers row before the delete).
    expect(await q.listProposalBlockers(dependent.id)).toEqual([])
    expect(await q.listBlockers(dependent.id)).toEqual([newBlocker.id])
    expect(await q.hasIncompleteBlockers(dependent.id)).toBe(true)
  })

  it('transfer is a no-op when no task depends on the idea', async () => {
    const { q, p } = await load(repo)
    const idea = await p.createProposal('idea with no dependents')
    const newBlocker = await q.enqueueTask('sliced')
    const { transferred } = await q.transferProposalBlockerToTask(
      idea.id,
      newBlocker.id,
    )
    expect(transferred).toEqual([])
  })

  it('transfer rejects when the new blocker task does not exist', async () => {
    const { q, p } = await load(repo)
    const dependent = await q.enqueueTask('dependent')
    const idea = await p.createProposal('idea')
    await q.addProposalBlockers(dependent.id, [idea.id])
    await expect(
      q.transferProposalBlockerToTask(idea.id, 'no-such-task'),
    ).rejects.toThrow(/blocker task no-such-task not found/)
    // Edge untouched on failure.
    expect(await q.listProposalBlockers(dependent.id)).toEqual([idea.id])
  })

  it('dismiss is refused while a task depends on the idea, and lists the dependents', async () => {
    const { q, p } = await load(repo)
    const dependent = await q.enqueueTask('dependent work')
    const idea = await p.createProposal('blocking idea')
    await q.addProposalBlockers(dependent.id, [idea.id])

    await expect(p.dismissProposal(idea.id)).rejects.toThrow(
      new RegExp(
        `cannot be dismissed.*${dependent.id}`,
      ),
    )
    // Status unchanged: still draft.
    const after = await p.getProposal(idea.id)
    expect(after?.status).toBe('draft')
  })

  it('delete is refused while a task depends on the idea, and lists the dependents', async () => {
    const { q, p } = await load(repo)
    const dependent = await q.enqueueTask('dependent work')
    const idea = await p.createProposal('blocking idea')
    await q.addProposalBlockers(dependent.id, [idea.id])

    await expect(p.deleteProposal(idea.id)).rejects.toThrow(
      new RegExp(`cannot be deleted.*${dependent.id}`),
    )
    const after = await p.getProposal(idea.id)
    expect(after?.status).toBe('draft')
  })

  it('dismiss succeeds once the dependent edge is removed', async () => {
    const { q, p } = await load(repo)
    const dependent = await q.enqueueTask('dependent work')
    const idea = await p.createProposal('blocking idea')
    await q.addProposalBlockers(dependent.id, [idea.id])
    await q.removeProposalBlocker(dependent.id, idea.id)
    const dismissed = await p.dismissProposal(idea.id)
    expect(dismissed.status).toBe('dismissed')
  })
})
