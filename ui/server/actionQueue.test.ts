import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { actionQueueResponseSchema } from '../src/shared/schemas.ts'
import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'
import { failureKindDecisions } from './actionQueueDecisions.ts'

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
  diagnosis: { text: string; diagnosedAt: string } | null
  decisions: Array<{ label: string; endpoint: string; payload: Record<string, unknown> }>
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-action-queue-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const dbPath = (repo: string): string => resolve(repo, '.mars/mars.db')

/** Create the action_queue_items table (and tasks for DAG enrichment). */
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
  await c.execute(`CREATE TABLE IF NOT EXISTS action_queue_items (
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
    raised_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    seen_count INTEGER NOT NULL DEFAULT 1,
    fingerprint TEXT,
    signature TEXT,
    resolved_at INTEGER,
    resolution TEXT,
    resolution_note TEXT,
    root_cause TEXT,
    resolved_by TEXT
  )`)
  return c
}

const insertActionQueueItem = async (
  c: Client,
  opts: {
    id: string
    kind: string
    priority?: string
    title?: string
    body?: string
    payload?: Record<string, unknown>
    context?: Record<string, unknown>
    /** Epoch milliseconds, matching the `raised_at` bigint column. */
    raisedAt?: number
  },
): Promise<void> => {
  const now = opts.raisedAt ?? Date.now()
  await c.execute({
    sql: `INSERT INTO action_queue_items (id, kind, priority, title, body, payload, context, raised_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      opts.id,
      opts.kind,
      opts.priority ?? 'high',
      opts.title ?? `actionQueue item ${opts.id}`,
      opts.body ?? '',
      JSON.stringify(opts.payload ?? {}),
      JSON.stringify(opts.context ?? {}),
      now,
      now,
    ],
  })
}

describe('GET /api/action-queue (persisted view)', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const c = await createSchema(dbPath(repo))
    c.close()
    // Inject a daemon stub so /api/action-queue (which now proxies the daemon's
    // /view/action-queue) is served from the seeded SQLite via the canonical
    // buildActionQueueView — no daemon process, single projection source.
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: makeDaemonStub(repo) },
    )
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
    const res = await fetch(`${baseUrl}/api/action-queue${q}`)
    expect(res.status).toBe(200)
    return (await res.json()) as ActionQueueItemBody[]
  }

  it('returns an empty array when action_queue_items is empty', async () => {
    const body = await fetchQueue()
    expect(body).toEqual([])
  })

  it('relays the daemon projection for a seeded action_queue_items row', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
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
    // The persisted kind reaches the UI verbatim — the view no longer collapses
    // every failure condition into a single 'failed-task' bucket.
    expect(row?.kind).toBe('failed')
    // entityId extracted from payload.taskId
    expect(row?.entityId).toBe('t-failed')
    expect(row?.priority).toBe('high')
    // errorKind preserved from persisted kind
    expect(row?.errorKind).toBe('failed-task')
    // The row's task carries no failure signature, so the registry can only
    // produce the generic label — and a persisted title the raiser wrote on
    // purpose beats the generic label and survives verbatim. (The task itself
    // is not in `tasks` here, so no ` [task …]` tag is appended.)
    expect(row?.title).toBe('Task t-failed failed')
    // actions ARE derived by the canonical buildActionQueueView — the persisted
    // row carries none — so their presence proves the proxy relays the daemon
    // projection rather than the raw SQLite row.
    expect(row?.actions.some((a) => a.op === 'diagnose-failure')).toBe(true)
  })

  it('replaces a generic persisted title with the derived failure copy', async () => {
    // The other half of the title contract: when the raiser fell back to the
    // generic label it says nothing the derived copy would not, so the
    // canonical view overwrites it. Asserting the exact derived string here is
    // what proves the proxy serves buildActionQueueView output, not passthrough.
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'test-row-generic',
      kind: 'failed',
      priority: 'high',
      title: 'Mars could not determine why this task failed',
      body: '',
      payload: { taskId: 't-failed', eventType: 'task.failed' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'test-row-generic')
    expect(row).toBeDefined()
    expect(row?.title).toBe('Mars could not determine why this task failed [task t-failed]')
  })

  it('a non-task-keyed failed row gets a non-empty entityId (origins-400 regression)', async () => {
    // The bug: a failed row with no taskId in payload/context was projected with
    // entityId '' by the old forked handler, which made OriginTree fetch
    // `/api/origins/?project=…` → 400. The canonical view falls back to
    // signature ?? id, so entityId is never empty.
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await c.execute({
      sql: `INSERT INTO action_queue_items (id, kind, priority, title, body, payload, context, raised_at, last_seen_at, signature)
            VALUES (?, 'failed', 'high', ?, '', '{}', '{}', ?, ?, ?)`,
      args: [
        'row-no-task',
        'Observability store oversize',
        Date.now(),
        Date.now(),
        'observability-store-oversize',
      ],
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'row-no-task')
    expect(row).toBeDefined()
    expect(row?.entityId).toBe('observability-store-oversize')
    expect(row?.entityId).not.toBe('')
  })

  it('maps daemon-killed kind to errorKind daemon-killed', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
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
    // daemon-killed survives as the row kind: the operator must be able to tell
    // a daemon kill apart from an ordinary verify failure at a glance.
    expect(row?.kind).toBe('daemon-killed')
    expect(row?.entityId).toBe('t-killed')
    // daemon-killed is preserved as errorKind so the right action menu is shown
    expect(row?.errorKind).toBe('daemon-killed')
  })

  it('maps stale-worktree kind from context.taskId', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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
    await insertActionQueueItem(c, {
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

  it('returns 200 with empty array when action_queue_items table does not exist', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await c.execute(`DROP TABLE IF EXISTS action_queue_items`)
    c.close()
    const body = await fetchQueue()
    expect(body).toEqual([])
  })

  it('does not include rows where state is not open', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'closed-row',
      kind: 'failed',
      payload: { taskId: 't-closed' },
    })
    // Mark it as resolved at the action_queue_items level
    await c.execute({
      sql: `UPDATE action_queue_items SET state = 'resolved' WHERE id = ?`,
      args: ['closed-row'],
    })
    c.close()

    const body = await fetchQueue()
    expect(body.find((r) => r.id === 'closed-row')).toBeUndefined()
  })

  it('produces a daemon-killed-batch synthetic row when ≥2 daemon-killed rows are open', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'dk-1',
      kind: 'daemon-killed',
      priority: 'high',
      payload: { taskId: 'task-dk-1' },
    })
    await insertActionQueueItem(c, {
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

  it('failed-task row: diagnosis passes through from payload as { text, diagnosedAt }', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'diag-row-1',
      kind: 'failed',
      priority: 'high',
      title: 'Task t-diag failed',
      payload: {
        taskId: 't-diag',
        diagnosis: {
          text: 'Migration ran against an already-migrated DB; not a real error.',
          diagnosedAt: '2026-05-27T16:00:00.000Z',
        },
      },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'diag-row-1')
    expect(row?.diagnosis?.text).toBe(
      'Migration ran against an already-migrated DB; not a real error.',
    )
    expect(row?.diagnosis?.diagnosedAt).toBe('2026-05-27T16:00:00.000Z')
  })

  it('failed-task row: diagnosis is null when payload has none', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'nodiag-row-1',
      kind: 'failed',
      priority: 'high',
      title: 'Task t-nodiag failed',
      payload: { taskId: 't-nodiag' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'nodiag-row-1')
    expect(row?.diagnosis).toBeNull()
  })

  it('coder-killed-by-restart row: decisions include Continue and Drop buttons', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'ckbr-row-1',
      kind: 'coder-killed-by-restart',
      priority: 'high',
      payload: { taskId: 't-ckbr' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'ckbr-row-1')
    expect(row).toBeDefined()
    // errorKind is preserved from the raw kind so failureKindDecisions receives it
    expect(row?.errorKind).toBe('coder-killed-by-restart')
    expect(row?.decisions).toHaveLength(2)
    expect(row?.decisions[0].label).toBe('Continue')
    expect(row?.decisions[1].label).toBe('Drop')
  })
})

describe('decisions per failure kind', () => {
  it('coder-killed-by-restart returns [Continue, Drop]', () => {
    const decisions = failureKindDecisions('coder-killed-by-restart')
    expect(decisions).toHaveLength(2)
    expect(decisions[0].label).toBe('Continue')
    expect(decisions[1].label).toBe('Drop')
    expect(typeof decisions[0].endpoint).toBe('string')
    expect(decisions[0].endpoint.length).toBeGreaterThan(0)
    expect(typeof decisions[0].payload).toBe('object')
  })

  it('verify-failed returns [Retry, Drop]', () => {
    const decisions = failureKindDecisions('verify-failed')
    expect(decisions).toHaveLength(2)
    expect(decisions[0].label).toBe('Retry')
    expect(decisions[1].label).toBe('Drop')
    expect(typeof decisions[0].endpoint).toBe('string')
  })

  it('merge-blocked returns [Retry Merge, Drop]', () => {
    const decisions = failureKindDecisions('merge-blocked')
    expect(decisions).toHaveLength(2)
    expect(decisions[0].label).toBe('Retry Merge')
    expect(decisions[1].label).toBe('Drop')
    expect(typeof decisions[0].endpoint).toBe('string')
  })

  it('unknown kind returns []', () => {
    expect(failureKindDecisions('some-unknown-kind')).toEqual([])
    expect(failureKindDecisions('')).toEqual([])
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
    errorKind: 'daemon-killed',
    actions: [],
  }

  const minimalStaleDetail = {
    prompt: 'fix the bug',
    status: 'running',
    ageHours: 24,
    updatedAt: new Date().toISOString(),
    branch: 'task/task-1',
    empty: false,
    investigation: null,
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

  it('preserves failed-task kind unchanged', () => {
    const parsed = actionQueueResponseSchema.parse([{ ...minimalRow, kind: 'failed-task' }])
    expect(parsed[0].kind).toBe('failed-task')
  })

  it('preserves draft-proposal kind unchanged', () => {
    const parsed = actionQueueResponseSchema.parse([{ ...minimalRow, kind: 'draft-proposal' }])
    expect(parsed[0].kind).toBe('draft-proposal')
  })

  it('preserves stale-worktree kind when staleWorktreeDetail is present', () => {
    const staleRow = { ...minimalRow, kind: 'stale-worktree', staleWorktreeDetail: minimalStaleDetail }
    const parsed = actionQueueResponseSchema.parse([staleRow])
    expect(parsed[0].kind).toBe('stale-worktree')
  })

  it('a stale-worktree row WITH staleWorktreeDetail parses correctly', () => {
    const staleRow = { ...minimalRow, kind: 'stale-worktree', staleWorktreeDetail: minimalStaleDetail }
    const parsed = actionQueueResponseSchema.parse([staleRow])
    expect(parsed[0].kind).toBe('stale-worktree')
    if (parsed[0].kind === 'stale-worktree') {
      expect(parsed[0].staleWorktreeDetail.prompt).toBe('fix the bug')
      expect(parsed[0].staleWorktreeDetail.empty).toBe(false)
    }
  })

  it('a failed-task row WITHOUT staleWorktreeDetail parses correctly', () => {
    const parsed = actionQueueResponseSchema.parse([{ ...minimalRow, kind: 'failed-task' }])
    expect(parsed[0].kind).toBe('failed-task')
    // staleWorktreeDetail is absent on the failed-task variant
    expect((parsed[0] as Record<string, unknown>)['staleWorktreeDetail']).toBeUndefined()
  })

  it('a row with an unknown kind coerces to the failed-task variant — does NOT throw, does NOT drop the array', () => {
    const raw = [
      { ...minimalRow, id: 'row-unknown', kind: 'some-future-kind' },
      { ...minimalRow, id: 'row-known', kind: 'failed-task' },
    ]
    let parsed: ReturnType<typeof actionQueueResponseSchema.parse> | undefined
    expect(() => { parsed = actionQueueResponseSchema.parse(raw) }).not.toThrow()
    expect(parsed).toHaveLength(2)
    expect(parsed![0].kind).toBe('failed-task')
    expect(parsed![1].kind).toBe('failed-task')
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

// ---------------------------------------------------------------------------
// Eligibility at the source/API boundary: kinds must survive intact so the UI
// can group them correctly (alerts vs blocked tasks vs proposals).
//
// "Intact" means verbatim. buildActionQueueView deliberately no longer collapses
// the persisted vocabulary into a smaller UI one — a 'failed' row stays 'failed'
// and a 'daemon-killed' row stays 'daemon-killed', because the operator needs to
// see which condition raised the row. A failed task must NOT arrive as 'blocked';
// a draft-proposal must NOT be swallowed into the failure bucket. These tests pin
// that contract at the data layer so a regression in buildActionQueueView would be
// caught before it mislabels items in the OpeningNextMoves widget.
// ---------------------------------------------------------------------------
describe('action-queue API: kind fidelity at source/UI boundary', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  beforeEach(async () => {
    repo = setupRepo()
    const c = await createSchema(dbPath(repo))
    c.close()
    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: makeDaemonStub(repo) },
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  const fetchQueue = async (): Promise<ActionQueueItemBody[]> => {
    const res = await fetch(`${baseUrl}/api/action-queue`)
    expect(res.status).toBe(200)
    return (await res.json()) as ActionQueueItemBody[]
  }

  it('a genuinely failed task arrives with kind="failed" (NOT kind="blocked")', async () => {
    // A task that failed is an alert, not a blocked task. The persisted kind is
    // relayed verbatim — 'failed' is the wire value, and grouping keys off it.
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'ft-kind-1',
      kind: 'failed',
      priority: 'high',
      title: 'Task failed during verify',
      payload: { taskId: 'task-verify-fail' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'ft-kind-1')
    expect(row?.kind).toBe('failed')
    // This is NOT a blocked task — the UI must not mislabel it
    expect(row?.kind).not.toBe('blocked')
  })

  it('a draft-proposal item arrives with kind="draft-proposal" (not coerced to failed-task)', async () => {
    // Draft proposals await human refinement; they must reach the
    // "proposals to refine" group in the opening, not the "alerts" group.
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'dp-kind-1',
      kind: 'draft-proposal',
      priority: 'low',
      title: 'New feature idea',
      payload: { proposalId: 'prop-abc', source: 'human' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'dp-kind-1')
    expect(row?.kind).toBe('draft-proposal')
    expect(row?.entityId).toBe('prop-abc')
    // A draft-proposal is not a failure or a blocked task
    expect(row?.kind).not.toBe('failed-task')
    expect(row?.kind).not.toBe('blocked')
  })

  it('awaiting-human item arrives with kind="awaiting-human" (distinct from blocked and failed)', async () => {
    // awaiting-human means a task is parked at a manual step — it is NOT the
    // same as a task in status='blocked' (dependency wait) or status='failed'.
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'ah-kind-1',
      kind: 'awaiting-human',
      priority: 'high',
      title: 'Task awaiting manual step',
      payload: { taskId: 'task-manual-step' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'ah-kind-1')
    expect(row?.kind).toBe('awaiting-human')
    // Must NOT be treated as a "blocked task" (status=blocked) or a failure
    expect(row?.kind).not.toBe('blocked')
    expect(row?.kind).not.toBe('failed-task')
  })

  it('a stale-worktree alert arrives with kind="stale-worktree" (not a blocked task)', async () => {
    // A stale worktree is an infrastructure alert — the task may still be
    // running, it just has not been updated recently. Not a blocked task.
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'sw-kind-1',
      kind: 'stale-worktree',
      priority: 'low',
      title: 'Stale worktree: task-stale',
      context: { taskId: 'task-stale' },
      payload: { ageHours: 30, status: 'running' },
    })
    c.close()

    const body = await fetchQueue()
    const row = body.find((r) => r.id === 'sw-kind-1')
    expect(row?.kind).toBe('stale-worktree')
    // stale-worktree is an alert, not a blocked task or a failure
    expect(row?.kind).not.toBe('blocked')
    expect(row?.kind).not.toBe('failed-task')
  })

  it('mixed queue: each kind is preserved so the UI can group them independently', async () => {
    const c = createClient({ url: `file:${dbPath(repo)}` })
    await insertActionQueueItem(c, {
      id: 'mix-ft',
      kind: 'failed',
      payload: { taskId: 'task-mix-fail' },
    })
    await insertActionQueueItem(c, {
      id: 'mix-dp',
      kind: 'draft-proposal',
      payload: { proposalId: 'prop-mix', source: 'human' },
    })
    await insertActionQueueItem(c, {
      id: 'mix-ah',
      kind: 'awaiting-human',
      payload: { taskId: 'task-mix-human' },
    })
    c.close()

    const body = await fetchQueue()
    const ft = body.find((r) => r.id === 'mix-ft')
    const dp = body.find((r) => r.id === 'mix-dp')
    const ah = body.find((r) => r.id === 'mix-ah')

    // Each arrives with its own distinct kind — the UI can group accurately
    expect(ft?.kind).toBe('failed')
    expect(dp?.kind).toBe('draft-proposal')
    expect(ah?.kind).toBe('awaiting-human')

    // No two kinds are the same
    const kinds = [ft?.kind, dp?.kind, ah?.kind]
    expect(new Set(kinds).size).toBe(3)
  })
})
