import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { actionQueueResponseSchema } from '../src/shared/schemas.ts'
import { startServer } from './index.ts'

interface ActionQueueItemBody {
  id: string
  kind: string
  entityId: string
  priority: string
  title: string
  body: string
  at: string
  dag: {
    blockers: Array<{ id: string; status: string; summary: string }>
    blocking: Array<{ id: string; status: string; summary: string }>
    descendants: Array<{ id: string; status: string; summary: string }>
    proposalId: string | null
  } | null
  dismissed: boolean
  ackState: 'ack' | 'resolved' | 'dismissed' | null
  errorKind: string
  actions: Array<{ id: string; label: string; op: string }>
  staleWorktreeDetail: {
    prompt: string | null
    status: string
    ageHours: number
    updatedAt: string
    branch: string | null
    empty: boolean
    investigation: string | null
  } | null
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-action-queue-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const dbPath = (repo: string): string => resolve(repo, '.mars/mars.db')

/** Create the inbox_items table (and tasks for DAG enrichment). */
const createSchema = async (path: string): Promise<Client> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_functional TEXT,
    plan_technical TEXT,
    branch TEXT,
    worktree_path TEXT,
    claude_session_id TEXT,
    error TEXT,
    drop_reason TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    parent_proposal_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  await c.execute(`CREATE TABLE IF NOT EXISTS task_blockers (
    task_id TEXT NOT NULL,
    blocker_task_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (task_id, blocker_task_id)
  )`)
  await c.execute(`CREATE TABLE IF NOT EXISTS inbox_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'orchestrator',
    priority TEXT NOT NULL DEFAULT 'high',
    state TEXT NOT NULL DEFAULT 'open',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '{}',
    context TEXT NOT NULL DEFAULT '{}',
    raised_by TEXT NOT NULL DEFAULT 'test',
    raised_at TEXT NOT NULL,
    last_seen_at TEXT,
    seen_count INTEGER NOT NULL DEFAULT 1,
    fingerprint TEXT,
    signature TEXT,
    resolved_at TEXT,
    resolution TEXT,
    resolution_note TEXT,
    root_cause TEXT,
    resolved_by TEXT
  )`)
  return c
}

const insertInboxItem = async (
  c: Client,
  opts: {
    id: string
    kind: string
    priority?: string
    title?: string
    body?: string
    payload?: Record<string, unknown>
    context?: Record<string, unknown>
    raisedAt?: string
  },
): Promise<void> => {
  const now = opts.raisedAt ?? new Date().toISOString()
  await c.execute({
    sql: `INSERT INTO inbox_items (id, kind, priority, title, body, payload, context, raised_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.kind,
      opts.priority ?? 'high',
      opts.title ?? `inbox item ${opts.id}`,
      opts.body ?? '',
      JSON.stringify(opts.payload ?? {}),
      JSON.stringify(opts.context ?? {}),
      now,
      now,
    ],
  })
}

describe('GET /api/inbox/action-queue (persisted view)', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const c = await createSchema(dbPath(repo))
    c.close()
    server = await startServer({ repo, port: 0, host: '127.0.0.1' })
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  const fetchQueue = async (
    filter?: string,
  ): Promise<ActionQueueItemBody[]> => {
    const q = filter ? `?filter=${filter}` : ''
    const res = await fetch(`${baseUrl}/api/inbox/action-queue${q}`)
    expect(res.status).toBe(200)
    return (await res.json()) as ActionQueueItemBody[]
  }

  it('returns an empty array when inbox_items is empty', async () => {
    const body = await fetchQueue()
    expect(body).toEqual([])
  })

  it('maps a seeded inbox_items row to a valid ActionQueueItem', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'test-row-1',
      kind: 'failed',
      priority: 'high',
      title: 'Task t-failed failed',
      body: 'Some failure body',
      payload: { taskId: 't-failed', eventType: 'task.failed' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'test-row-1')
    expect(row).toBeDefined()
    // Persisted id (UUID) is used as the row id, not kind:entityId
    expect(row?.id).toBe('test-row-1')
    // Persisted 'failed' kind maps to UI 'failed-task'
    expect(row?.kind).toBe('failed-task')
    // entityId extracted from payload.taskId
    expect(row?.entityId).toBe('t-failed')
    expect(row?.priority).toBe('high')
    expect(row?.title).toBe('Task t-failed failed')
    expect(row?.body).toBe('Some failure body')
    expect(row?.dismissed).toBe(false)
    expect(row?.ackState).toBeNull()
    // errorKind preserved from persisted kind
    expect(row?.errorKind).toBe('failed-task')
    expect(row?.actions).toEqual([])
  })

  it('maps daemon-killed kind to errorKind daemon-killed', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'dk-row-1',
      kind: 'daemon-killed',
      priority: 'high',
      title: 'Task was daemon-killed',
      payload: { taskId: 't-killed' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'dk-row-1')
    expect(row).toBeDefined()
    expect(row?.kind).toBe('failed-task')
    expect(row?.entityId).toBe('t-killed')
    // daemon-killed is preserved as errorKind so the right action menu is shown
    expect(row?.errorKind).toBe('daemon-killed')
  })

  it('maps stale-worktree kind from context.taskId', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'sw-row-1',
      kind: 'stale-worktree',
      priority: 'low',
      title: 'Stale worktree: mars-abc',
      context: { taskId: 'mars-abc' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'sw-row-1')
    expect(row).toBeDefined()
    expect(row?.kind).toBe('stale-worktree')
    expect(row?.entityId).toBe('mars-abc')
    expect(row?.priority).toBe('low')
    expect(row?.errorKind).toBe('stale-worktree')
  })

  it('stale-worktree row has staleWorktreeDetail populated from payload', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'sw-detail-1',
      kind: 'stale-worktree',
      priority: 'low',
      title: 'Stale worktree: task-detail',
      context: { taskId: 'task-detail' },
      payload: {
        prompt: 'fix the bug in foo.ts',
        status: 'running',
        ageHours: 26.5,
        branch: 'task/task-detail',
        investigation: null,
      },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'sw-detail-1')
    expect(row).toBeDefined()
    expect(row?.staleWorktreeDetail).not.toBeNull()
    expect(row?.staleWorktreeDetail?.prompt).toBe('fix the bug in foo.ts')
    expect(row?.staleWorktreeDetail?.status).toBe('running')
    expect(row?.staleWorktreeDetail?.ageHours).toBe(26.5)
    expect(row?.staleWorktreeDetail?.branch).toBe('task/task-detail')
    // No worktree directory exists → conservative: empty=false
    expect(row?.staleWorktreeDetail?.empty).toBe(false)
    expect(row?.staleWorktreeDetail?.investigation).toBeNull()
  })

  it('stale-worktree row: investigation field passes through from payload', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'sw-invest-1',
      kind: 'stale-worktree',
      priority: 'low',
      title: 'Stale worktree: task-invest',
      context: { taskId: 'task-invest' },
      payload: {
        prompt: 'some task',
        status: 'running',
        ageHours: 30,
        branch: null,
        investigation: 'The agent got stuck on step 3 because of missing env var.',
      },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'sw-invest-1')
    expect(row?.staleWorktreeDetail?.investigation).toBe(
      'The agent got stuck on step 3 because of missing env var.',
    )
  })

  it('stale-worktree row: status falls back to absent sentinel when task row is missing', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'sw-absent-1',
      kind: 'stale-worktree',
      priority: 'low',
      title: 'Stale worktree: no-task',
      context: { taskId: 'no-such-task' },
      payload: {},
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'sw-absent-1')
    expect(row?.staleWorktreeDetail?.status).toBe('absent (no matching task)')
    expect(row?.staleWorktreeDetail?.prompt).toBeNull()
  })

  it('non-stale-worktree rows have staleWorktreeDetail: null', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'failed-no-detail',
      kind: 'failed',
      priority: 'high',
      title: 'Task failed',
      payload: { taskId: 't-failed-2' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'failed-no-detail')
    expect(row).toBeDefined()
    expect(row?.staleWorktreeDetail).toBeNull()
  })

  it('stale-worktree row: empty=true for a worktree with no diff vs main', async () => {
    const taskId = 'task-empty-wt'
    const worktreeDir = resolve(repo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })
    // Set up a standalone git repo inside the worktree directory, mirroring
    // how the orchestrator leaves a worktree after branching off main with
    // no commits added by the agent.
    execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: worktreeDir })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: worktreeDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktreeDir })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: worktreeDir })
    // Branch off main — no additional commits; worktree is clean
    execFileSync('git', ['checkout', '-b', `task/${taskId}`], { cwd: worktreeDir })

    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'sw-empty-wt',
      kind: 'stale-worktree',
      priority: 'low',
      title: `Stale worktree: ${taskId}`,
      context: { taskId },
      payload: { ageHours: 25, status: 'running' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'sw-empty-wt')
    expect(row?.staleWorktreeDetail?.empty).toBe(true)
  })

  it('stale-worktree row: empty=false for a worktree with committed changes', async () => {
    const taskId = 'task-nonempty-wt'
    const worktreeDir = resolve(repo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })
    execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: worktreeDir })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: worktreeDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktreeDir })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: worktreeDir })
    execFileSync('git', ['checkout', '-b', `task/${taskId}`], { cwd: worktreeDir })
    // Add a real file change so the diff vs main is non-empty
    Bun.write(resolve(worktreeDir, 'change.ts'), 'export const x = 1')
    execFileSync('git', ['add', 'change.ts'], { cwd: worktreeDir })
    execFileSync('git', ['commit', '-m', 'work done'], { cwd: worktreeDir })

    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'sw-nonempty-wt',
      kind: 'stale-worktree',
      priority: 'low',
      title: `Stale worktree: ${taskId}`,
      context: { taskId },
      payload: { ageHours: 25, status: 'running' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'sw-nonempty-wt')
    expect(row?.staleWorktreeDetail?.empty).toBe(false)
  })

  it('stale-worktree row: empty=false for a worktree with untracked files', async () => {
    const taskId = 'task-untracked-wt'
    const worktreeDir = resolve(repo, '.mars', 'worktrees', taskId)
    mkdirSync(worktreeDir, { recursive: true })
    execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: worktreeDir })
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: worktreeDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: worktreeDir })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: worktreeDir })
    execFileSync('git', ['checkout', '-b', `task/${taskId}`], { cwd: worktreeDir })
    // Add an untracked file (not committed, not staged)
    Bun.write(resolve(worktreeDir, 'untracked.txt'), 'some work')

    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'sw-untracked-wt',
      kind: 'stale-worktree',
      priority: 'low',
      title: `Stale worktree: ${taskId}`,
      context: { taskId },
      payload: { ageHours: 25, status: 'running' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'sw-untracked-wt')
    expect(row?.staleWorktreeDetail?.empty).toBe(false)
  })

  it('maps draft-proposal kind from payload.proposalId', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'dp-row-1',
      kind: 'draft-proposal',
      priority: 'low',
      title: 'Draft: some proposal',
      payload: { proposalId: 'prop-123', source: 'human' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'dp-row-1')
    expect(row).toBeDefined()
    expect(row?.kind).toBe('draft-proposal')
    expect(row?.entityId).toBe('prop-123')
    expect(row?.errorKind).toBe('draft-proposal')
    expect(row?.dag).toBeNull()
  })

  it('maps urgent priority to high', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'prio-row-1',
      kind: 'failed',
      priority: 'urgent',
      payload: { taskId: 't-urgent' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'prio-row-1')
    expect(row?.priority).toBe('high')
  })

  it('hides dismissed rows from the open filter and shows them under dismissed filter', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'dis-row-1',
      kind: 'failed',
      priority: 'high',
      payload: { taskId: 't-to-dismiss' },
    })
    c.close()

    // Dismiss via the ack/dismiss API using kind:entityId format
    const dismissRes = await fetch(`${baseUrl}/api/inbox/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'failed-task:t-to-dismiss' }),
    })
    expect(dismissRes.status).toBe(200)

    // Should not appear in open filter
    const open = await fetchQueue()
    expect(open.find((r) => r.id === 'dis-row-1')).toBeUndefined()

    // Should appear under dismissed filter
    const dismissed = await fetchQueue('dismissed')
    const row = dismissed.find((r) => r.id === 'dis-row-1')
    expect(row).toBeDefined()
    expect(row?.dismissed).toBe(true)
    expect(row?.ackState).toBe('dismissed')

    // Should appear under all filter
    const all = await fetchQueue('all')
    expect(all.find((r) => r.id === 'dis-row-1')).toBeDefined()
  })

  it('ack keeps row visible in open filter; resolve hides it — round trip', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'ack-row-1',
      kind: 'failed',
      priority: 'high',
      payload: { taskId: 't-ack' },
    })
    c.close()

    // Baseline: appears in open filter with no ackState
    const before = await fetchQueue()
    const row0 = before.find((r) => r.id === 'ack-row-1')
    expect(row0).toBeDefined()
    expect(row0?.ackState).toBeNull()
    expect(row0?.dismissed).toBe(false)

    // Ack
    const ackRes = await fetch(`${baseUrl}/api/inbox/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'failed-task:t-ack' }),
    })
    expect(ackRes.status).toBe(200)

    // After ack: still shows in open filter, but ackState='ack'
    const afterAck = await fetchQueue()
    const rowAck = afterAck.find((r) => r.id === 'ack-row-1')
    expect(rowAck).toBeDefined()
    expect(rowAck?.ackState).toBe('ack')
    expect(rowAck?.dismissed).toBe(false)

    // Resolve
    const resolveRes = await fetch(`${baseUrl}/api/inbox/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'failed-task:t-ack' }),
    })
    expect(resolveRes.status).toBe(200)

    // After resolve: hidden from open filter
    const afterResolve = await fetchQueue()
    expect(afterResolve.find((r) => r.id === 'ack-row-1')).toBeUndefined()

    // But visible under all with resolved ackState
    const allRows = await fetchQueue('all')
    const rowResolved = allRows.find((r) => r.id === 'ack-row-1')
    expect(rowResolved?.ackState).toBe('resolved')
    expect(rowResolved?.dismissed).toBe(true)
  })

  it('returns 200 with empty array when inbox_items table does not exist', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await c.execute(`DROP TABLE IF EXISTS inbox_items`)
    c.close()
    const body = await fetchQueue()
    expect(body).toEqual([])
  })

  it('does not include rows where state is not open', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'closed-row',
      kind: 'failed',
      payload: { taskId: 't-closed' },
    })
    // Mark it as resolved at the inbox_items level
    await c.execute({
      sql: `UPDATE inbox_items SET state = 'resolved' WHERE id = ?`,
      args: ['closed-row'],
    })
    c.close()

    const body = await fetchQueue()
    expect(body.find((r) => r.id === 'closed-row')).toBeUndefined()

    // Also not in dismissed filter (inbox_dismissals is empty)
    const dismissed = await fetchQueue('dismissed')
    expect(dismissed.find((r) => r.id === 'closed-row')).toBeUndefined()
  })

  it('produces a daemon-killed-batch synthetic row when ≥2 daemon-killed rows are open', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertInboxItem(c, {
      id: 'dk-1',
      kind: 'daemon-killed',
      priority: 'high',
      payload: { taskId: 'task-dk-1' },
    })
    await insertInboxItem(c, {
      id: 'dk-2',
      kind: 'daemon-killed',
      priority: 'high',
      payload: { taskId: 'task-dk-2' },
    })
    c.close()

    const body = await fetchQueue()
    const batchRow = body.find((r) => r.entityId === '__daemon-killed-batch__')
    expect(batchRow).toBeDefined()
    expect(batchRow?.errorKind).toBe('daemon-killed-batch')
  })
})

describe('actionQueueResponseSchema resilience', () => {
  const minimalRow = {
    id: 'test-id',
    entityId: 'task-1',
    priority: 'high' as const,
    title: 'Test',
    body: '',
    at: new Date().toISOString(),
    dag: null,
    dismissed: false,
    ackState: null,
    errorKind: 'daemon-killed',
    actions: [],
    staleWorktreeDetail: null,
  }

  it('parses a response array containing an unknown kind (daemon-killed) without throwing', () => {
    const raw = [{ ...minimalRow, kind: 'daemon-killed' }]
    expect(() => actionQueueResponseSchema.parse(raw)).not.toThrow()
  })

  it('coerces an unknown kind to failed-task', () => {
    const raw = [{ ...minimalRow, kind: 'daemon-killed' }]
    const parsed = actionQueueResponseSchema.parse(raw)
    expect(parsed[0].kind).toBe('failed-task')
  })

  it('preserves valid kinds unchanged', () => {
    const validKinds = ['failed-task', 'stale-worktree', 'draft-proposal'] as const
    for (const kind of validKinds) {
      const parsed = actionQueueResponseSchema.parse([{ ...minimalRow, kind }])
      expect(parsed[0].kind).toBe(kind)
    }
  })

  it('does not discard other rows when one row has an unknown kind', () => {
    const raw = [
      { ...minimalRow, id: 'row-1', kind: 'daemon-killed' },
      { ...minimalRow, id: 'row-2', kind: 'failed-task' },
    ]
    const parsed = actionQueueResponseSchema.parse(raw)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].kind).toBe('failed-task')
    expect(parsed[1].kind).toBe('failed-task')
  })
})
