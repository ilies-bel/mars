/**
 * Outbox producers test: every wrapped mutation emits exactly one matching
 * event row in the events table, with a schema-valid payload. Also asserts
 * that no event is emitted when updateTask is called with an unchanged status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseEvent } from '../../bus/events'

interface QueueMod {
  initQueue: typeof import('../queue').initQueue
  getClient: typeof import('../queue').getClient
  enqueueTask: typeof import('../queue').enqueueTask
  updateTask: typeof import('../queue').updateTask
}

interface ProposalsMod {
  initProposals: typeof import('../proposals').initProposals
  createProposal: typeof import('../proposals').createProposal
  addProposalUserStory: typeof import('../proposals').addProposalUserStory
  promoteProposal: typeof import('../proposals').promoteProposal
  deleteProposal: typeof import('../proposals').deleteProposal
}

interface ActionQueueMod {
  initActionQueue: typeof import('../lib/action-queue').initActionQueue
  raiseActionQueueItem: typeof import('../lib/action-queue').raiseActionQueueItem
  setActionQueueState: typeof import('../lib/action-queue').setActionQueueState
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-outbox-producers-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadMods = async (
  repo: string,
): Promise<{ q: QueueMod; p: ProposalsMod; actionQueue: ActionQueueMod }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../queue')) as unknown as QueueMod
  const p = (await import('../proposals')) as unknown as ProposalsMod
  const actionQueue = (await import('../lib/action-queue')) as unknown as ActionQueueMod
  await q.initQueue()
  await p.initProposals()
  await actionQueue.initActionQueue()
  return { q, p, actionQueue }
}

const getEvents = async (
  q: QueueMod,
  type: string,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> => {
  const client = q.getClient()
  const result = await client.execute({
    sql: `SELECT type, payload FROM events WHERE type = ? ORDER BY id`,
    args: [type],
  })
  return (result.rows as unknown as Array<{ type: string; payload: string }>).map(
    (r) => ({
      type: r.type,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }),
  )
}

const countEvents = async (q: QueueMod, type: string): Promise<number> => {
  const client = q.getClient()
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM events WHERE type = ?`,
    args: [type],
  })
  return Number((result.rows[0] as unknown as { n: number | bigint }).n ?? 0)
}

describe('outbox producers', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ─── updateTask status transitions ──────────────────────────────────────────

  describe('updateTask status transitions', () => {
    it('emits task.failed when status transitions to failed', async () => {
      const { q } = await loadMods(repo)
      const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
      await q.updateTask(task.id, { status: 'failed', error: 'verify step failed' })

      const events = await getEvents(q, 'task.failed')
      expect(events).toHaveLength(1)
      expect(() => parseEvent('task.failed', events[0].payload)).not.toThrow()
      expect(events[0].payload).toMatchObject({ taskId: task.id, error: 'verify step failed' })
    })

    it('emits task.dropped when status transitions to dropped', async () => {
      const { q } = await loadMods(repo)
      const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
      await q.updateTask(task.id, { status: 'dropped', failureReason: 'user skipped' })

      const events = await getEvents(q, 'task.dropped')
      expect(events).toHaveLength(1)
      expect(() => parseEvent('task.dropped', events[0].payload)).not.toThrow()
      expect(events[0].payload).toMatchObject({ taskId: task.id, dropReason: 'user skipped' })
    })

    it('emits task.queued when status transitions to queued', async () => {
      const { q } = await loadMods(repo)
      // Start with a draft task (skipTriage: false produces draft status)
      const task = await q.enqueueTask('test task')
      await q.updateTask(task.id, { status: 'queued' })

      const events = await getEvents(q, 'task.queued')
      expect(events).toHaveLength(1)
      expect(() => parseEvent('task.queued', events[0].payload)).not.toThrow()
      expect(events[0].payload).toMatchObject({ taskId: task.id })
    })

    it('emits task.blocked when status transitions to blocked', async () => {
      const { q } = await loadMods(repo)
      const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
      await q.updateTask(task.id, {
        status: 'blocked',
        failureSignature: 'sig-abc',
        failedPhase: 'verify',
      })

      const events = await getEvents(q, 'task.blocked')
      expect(events).toHaveLength(1)
      expect(() => parseEvent('task.blocked', events[0].payload)).not.toThrow()
      expect(events[0].payload).toMatchObject({
        taskId: task.id,
        fixTaskId: null,
        failureSignature: 'sig-abc',
        failingStep: 'verify',
      })
    })

    it('emits task.completed when status transitions to done', async () => {
      const { q } = await loadMods(repo)
      const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
      await q.updateTask(task.id, { status: 'done' })

      const events = await getEvents(q, 'task.completed')
      expect(events).toHaveLength(1)
      expect(() => parseEvent('task.completed', events[0].payload)).not.toThrow()
      expect(events[0].payload).toMatchObject({ taskId: task.id })
    })

    it('does NOT emit an event when status is written but unchanged', async () => {
      const { q } = await loadMods(repo)
      const task = await q.enqueueTask('test task', undefined, { skipTriage: true })
      // task is already 'queued' — writing the same status should be a no-op
      await q.updateTask(task.id, { status: 'queued' })
      await q.updateTask(task.id, { status: 'queued' })

      const events = await getEvents(q, 'task.queued')
      // No events: the status was already 'queued' before both writes
      expect(events).toHaveLength(0)
    })

    it('emits exactly one event per real status transition, not for no-ops', async () => {
      const { q } = await loadMods(repo)
      const task = await q.enqueueTask('test task')
      // draft → queued (real change, emits task.queued)
      await q.updateTask(task.id, { status: 'queued' })
      // queued → queued (no-op, no event)
      await q.updateTask(task.id, { status: 'queued' })
      // queued → done (real change, emits task.completed)
      await q.updateTask(task.id, { status: 'done' })

      expect(await countEvents(q, 'task.queued')).toBe(1)
      expect(await countEvents(q, 'task.completed')).toBe(1)
    })
  })

  // ─── proposal lifecycle ──────────────────────────────────────────────────────

  describe('deleteProposal emits proposal.deleted', () => {
    it('emits proposal.deleted with proposalId after deletion', async () => {
      const { q, p } = await loadMods(repo)
      const proposal = await p.createProposal('Proposal to delete', { source: 'human' })
      await p.deleteProposal(proposal.id)

      const events = await getEvents(q, 'proposal.deleted')
      expect(events).toHaveLength(1)
      expect(() => parseEvent('proposal.deleted', events[0].payload)).not.toThrow()
      expect(events[0].payload).toEqual({ proposalId: proposal.id })
    })
  })

  // ─── actionQueue lifecycle ─────────────────────────────────────────────────────────

  describe('raiseActionQueueItem emits actionQueue.raised on new insert', () => {
    it('emits actionQueue.raised with correct payload when a new item is inserted', async () => {
      const { q, actionQueue } = await loadMods(repo)
      const id = await actionQueue.raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: 'Task failed',
        body: 'Details here',
        payload: { taskId: 'abc123' },
        context: {},
        raisedBy: 'orchestrator:verify',
        signature: 'task-abc123',
      })

      const events = await getEvents(q, 'action-queue.raised')
      expect(events).toHaveLength(1)
      expect(() => parseEvent('action-queue.raised', events[0].payload)).not.toThrow()
      expect(events[0].payload).toMatchObject({
        itemId: id,
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        signature: 'task-abc123',
      })
    })

    it('does NOT emit actionQueue.raised on the dedup-bump path (same fingerprint)', async () => {
      const { q, actionQueue } = await loadMods(repo)
      const item = {
        kind: 'failed' as const,
        category: 'orchestrator',
        priority: 'high' as const,
        title: 'Task failed',
        body: 'Details',
        payload: { taskId: 'abc123' },
        context: {},
        raisedBy: 'orchestrator:verify',
        signature: 'task-abc123',
      }
      // First raise — inserts a new row, emits actionQueue.raised
      await actionQueue.raiseActionQueueItem(item)
      // Second raise — bumps seen_count on existing open row, must NOT emit
      await actionQueue.raiseActionQueueItem({ ...item, title: 'Updated title' })

      const events = await getEvents(q, 'action-queue.raised')
      // Only one event from the first insert
      expect(events).toHaveLength(1)
    })
  })

  describe('setActionQueueState emits actionQueue.resolved on terminal transition', () => {
    it('emits actionQueue.resolved when item transitions to resolved', async () => {
      const { q, actionQueue } = await loadMods(repo)
      const id = await actionQueue.raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'normal',
        title: 'Test',
        body: '',
        payload: {},
        context: {},
        raisedBy: 'test',
        signature: 'sig-resolve-test',
      })
      await actionQueue.setActionQueueState(id, 'resolved', { by: 'operator' })

      const events = await getEvents(q, 'action-queue.resolved')
      expect(events).toHaveLength(1)
      expect(() => parseEvent('action-queue.resolved', events[0].payload)).not.toThrow()
      expect(events[0].payload).toMatchObject({
        itemId: id,
        fromState: 'open',
        toState: 'resolved',
        by: 'operator',
      })
    })

    it('emits actionQueue.resolved when item transitions to dismissed', async () => {
      const { q, actionQueue } = await loadMods(repo)
      const id = await actionQueue.raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'normal',
        title: 'Test',
        body: '',
        payload: {},
        context: {},
        raisedBy: 'test',
        signature: 'sig-dismiss-test',
      })
      await actionQueue.setActionQueueState(id, 'dismissed', { by: 'operator' })

      const events = await getEvents(q, 'action-queue.resolved')
      expect(events).toHaveLength(1)
      expect(events[0].payload).toMatchObject({
        itemId: id,
        fromState: 'open',
        toState: 'dismissed',
      })
    })

    it('does NOT emit actionQueue.resolved on a non-terminal transition (acknowledged)', async () => {
      const { q, actionQueue } = await loadMods(repo)
      const id = await actionQueue.raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'normal',
        title: 'Test',
        body: '',
        payload: {},
        context: {},
        raisedBy: 'test',
        signature: 'sig-ack-test',
      })
      await actionQueue.setActionQueueState(id, 'acknowledged')

      const events = await getEvents(q, 'action-queue.resolved')
      expect(events).toHaveLength(0)
    })
  })
})
