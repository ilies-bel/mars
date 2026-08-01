import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient, type Client } from '@libsql/client'

import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'

/**
 * Slice 4 of PRD 10150b71: the Progress tab's column view must surface
 * exactly three task clusters — In progress, Blocked, Failed — and the
 * column header count must be a single cluster-level integer that does
 * NOT decompose into the granular queued/running/verifying/merging
 * statuses underneath "In progress". Proposal nodes must not appear in
 * any column.
 *
 * The cluster taxonomy lives server-side in `listProgressTasks`; the UI
 * counts `byCluster[c].length` and renders one integer per column. So if
 * the server returns the right shape with the right cluster tags, the
 * column-view contract is satisfied — these tests pin that shape.
 */

interface ProgressTaskBody {
  id: string
  status: string
  cluster: 'Queued' | 'In progress' | 'Blocked' | 'Failed'
}

interface ProgressBody {
  tasks: ProgressTaskBody[]
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-progress-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const createQueueSchema = async (path: string): Promise<Client> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE tasks (
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)
  return c
}

const createStateSchema = async (path: string): Promise<Client> => {
  const c = createClient({ url: `file:${path}` })
  await c.execute(`CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    problem TEXT NOT NULL DEFAULT '',
    solution TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL DEFAULT 'human',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  await c.execute(`CREATE TABLE proposal_user_stories (
    proposal_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY(proposal_id, position)
  )`)
  return c
}

const insertTask = async (
  c: Client,
  id: string,
  status: string,
  updatedAt: string = new Date().toISOString(),
): Promise<void> => {
  await c.execute({
    sql: `INSERT INTO tasks (id, prompt, status, retry_count, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)`,
    args: [id, `prompt for ${id}`, status, updatedAt, updatedAt],
  })
}

const insertProposal = async (
  c: Client,
  id: string,
): Promise<void> => {
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO proposals (id, title, status, source, created_at, updated_at)
          VALUES (?, ?, 'draft', 'human', ?, ?)`,
    args: [id, `title for ${id}`, now, now],
  })
}

const countBy = (
  tasks: ProgressTaskBody[],
): Record<'Queued' | 'In progress' | 'Blocked' | 'Failed', number> => {
  const out: Record<'Queued' | 'In progress' | 'Blocked' | 'Failed', number> = {
    Queued: 0,
    'In progress': 0,
    Blocked: 0,
    Failed: 0,
  }
  for (const t of tasks) out[t.cluster] += 1
  return out
}

describe('GET /api/progress — column-view cluster contract', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let queueDbPath: string

  beforeEach(async () => {
    repo = setupRepo()
    queueDbPath = resolve(repo, '.mars/mars.db')
    const stateDbPath = resolve(repo, '.mars/mars.db')
    const qc = await createQueueSchema(queueDbPath)
    const sc = await createStateSchema(stateDbPath)
    qc.close()
    sc.close()

    server = await startServer(
      {
        repo,
        port: 0,
        host: '127.0.0.1',
      },
      { proxyGet: makeDaemonStub(repo) },
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterEach(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('queued tasks land in Queued; running/verifying/merging/vega-reconciling tasks land in In progress', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-queued', 'queued')
    await insertTask(qc, 't-running', 'running')
    await insertTask(qc, 't-verifying', 'verifying')
    await insertTask(qc, 't-merging', 'merging')
    await insertTask(qc, 't-vega', 'vega-reconciling')
    qc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ProgressBody
    const counts = countBy(body.tasks)

    // queued tasks are now separate from actively-running work.
    expect(counts.Queued).toBe(1)
    // running/verifying/merging/vega-reconciling all collapse into In progress.
    expect(counts['In progress']).toBe(4)
    expect(counts.Blocked).toBe(0)
    expect(counts.Failed).toBe(0)

    // Every task carries exactly one of the four cluster tags — no
    // task leaks a granular status into the cluster taxonomy.
    for (const t of body.tasks) {
      expect(['Queued', 'In progress', 'Blocked', 'Failed']).toContain(t.cluster)
    }
  })

  it('buckets blocked into Blocked and failed into Failed, with single-integer cluster counts', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-blocked-1', 'blocked')
    await insertTask(qc, 't-blocked-2', 'blocked')
    await insertTask(qc, 't-failed-1', 'failed')
    qc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBody
    const counts = countBy(body.tasks)

    expect(counts.Queued).toBe(0)
    expect(counts['In progress']).toBe(0)
    expect(counts.Blocked).toBe(2)
    expect(counts.Failed).toBe(1)
  })

  it('excludes draft / done / dropped tasks from every column', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-draft', 'draft')
    await insertTask(qc, 't-done', 'done')
    await insertTask(qc, 't-dropped', 'dropped')
    await insertTask(qc, 't-running', 'running')
    qc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBody

    const ids = body.tasks.map((t) => t.id).sort()
    expect(ids).toEqual(['t-running'])
    const counts = countBy(body.tasks)
    expect(counts['In progress']).toBe(1)
    expect(counts.Blocked).toBe(0)
    expect(counts.Failed).toBe(0)
  })

  it('does not surface proposals as tasks in any column', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-running', 'running')
    qc.close()
    const sc = createClient({ url: `file:${resolve(repo, '.mars/mars.db')}` })
    await insertProposal(sc, 'proposal-1')
    await insertProposal(sc, 'proposal-2')
    sc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBody

    // The progress payload is tasks only — proposals must not leak in.
    const ids = body.tasks.map((t) => t.id).sort()
    expect(ids).toEqual(['t-running'])
    for (const t of body.tasks) {
      expect(t.id.startsWith('proposal-')).toBe(false)
    }
  })

  it('returns no cluster keys outside the four-column taxonomy', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-queued', 'queued')
    await insertTask(qc, 't-running', 'running')
    await insertTask(qc, 't-blocked', 'blocked')
    await insertTask(qc, 't-failed', 'failed')
    qc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBody

    const clusters = new Set(body.tasks.map((t) => t.cluster))
    for (const c of clusters) {
      expect(['Queued', 'In progress', 'Blocked', 'Failed']).toContain(c)
    }
    // All four taxonomy buckets are exhausted by the inserted tasks.
    expect(clusters.has('Queued')).toBe(true)
    expect(clusters.has('In progress')).toBe(true)
    expect(clusters.has('Blocked')).toBe(true)
    expect(clusters.has('Failed')).toBe(true)
  })

  it('task detail endpoint returns the granular status for In-progress tasks so the card drawer can surface it', async () => {
    // A 'running' task collapses into the 'In progress' cluster in the
    // column view — the header shows one integer for the cluster, not
    // 'running' vs 'queued'. The card drawer hits /api/tasks/:id to
    // display the granular status so the operator can distinguish them.
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-running', 'running')
    qc.close()

    const progressRes = await fetch(`${baseUrl}/api/progress`)
    const progressBody = (await progressRes.json()) as ProgressBody
    const col = progressBody.tasks.find((t) => t.id === 't-running')
    expect(col?.cluster).toBe('In progress')

    // The task detail endpoint (powering the drawer) returns the granular
    // 'running' status — the cluster label 'In progress' is not exposed.
    const detailRes = await fetch(`${baseUrl}/api/tasks/t-running`)
    expect(detailRes.status).toBe(200)
    const detailBody = (await detailRes.json()) as { task: { status: string } }
    expect(detailBody.task.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// Slice 3 of PRD 10150b71: DAG view — proposal nodes in the progress response
// ---------------------------------------------------------------------------

interface ProgressBodyWithProposals {
  tasks: ProgressTaskBody[]
  proposals: Array<{ id: string; title: string; source: string; status: string }>
}

describe('GET /api/progress — proposal nodes for DAG view', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let queueDbPath: string
  let stateDbPath: string

  beforeEach(async () => {
    repo = setupRepo()
    queueDbPath = resolve(repo, '.mars/mars.db')
    stateDbPath = resolve(repo, '.mars/mars.db')
    const qc = await createQueueSchema(queueDbPath)
    // Add parent_proposal_id column for provenance tracking
    await qc.execute(`ALTER TABLE tasks ADD COLUMN parent_proposal_id TEXT`)
    qc.close()
    const sc = await createStateSchema(stateDbPath)
    sc.close()

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

  it('returns proposals array alongside tasks when an in-scope task has a parent_proposal_id', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, retry_count, created_at, updated_at, parent_proposal_id)
            VALUES (?, ?, ?, 0, ?, ?, ?)`,
      args: ['t-sliced', 'prompt for t-sliced', 'running', new Date().toISOString(), new Date().toISOString(), 'p-abc'],
    })
    qc.close()

    const sc = createClient({ url: `file:${stateDbPath}` })
    await insertProposal(sc, 'p-abc')
    sc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ProgressBodyWithProposals

    expect(body.proposals).toBeDefined()
    expect(body.proposals.length).toBe(1)
    expect(body.proposals[0]!.id).toBe('p-abc')
    expect(body.proposals[0]!.title).toBe('title for p-abc')
  })

  it('returns an empty proposals array when no in-scope task has a parent_proposal_id', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-running', 'running')
    qc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBodyWithProposals

    expect(Array.isArray(body.proposals)).toBe(true)
    expect(body.proposals.length).toBe(0)
  })

  /** Insert a task carrying a parent_proposal_id, at an arbitrary status. */
  const insertSlicedTask = async (
    client: Client,
    id: string,
    status: string,
    proposalId: string,
  ): Promise<void> => {
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks (id, prompt, status, retry_count, created_at, updated_at, parent_proposal_id)
            VALUES (?, ?, ?, 0, ?, ?, ?)`,
      args: [id, 'prompt', status, now, now, proposalId],
    })
  }

  it('excludes proposals whose only sliced tasks are out of scope (draft/dropped)', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertSlicedTask(qc, 't-draft', 'draft', 'p-draft')
    await insertSlicedTask(qc, 't-dropped', 'dropped', 'p-dropped')
    // Also insert an in-scope task with no proposal
    await insertTask(qc, 't-running', 'running')
    qc.close()

    const sc = createClient({ url: `file:${stateDbPath}` })
    await insertProposal(sc, 'p-draft')
    await insertProposal(sc, 'p-dropped')
    sc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBodyWithProposals

    const proposalIds = body.proposals.map((p) => p.id)
    expect(proposalIds).not.toContain('p-draft')
    expect(proposalIds).not.toContain('p-dropped')
  })

  it('includes a proposal whose only sliced task is done — Done is an in-scope cluster', async () => {
    // Regression guard for 8f2a5a12 "done origin no longer triggers false
    // 'Abandoned arc / origin force-purged'". Before that commit clusterFor
    // ('done') returned null and a done task was dropped from the progress
    // projection entirely, which made buildArcsByCluster read the missing
    // origin row as force-purged. Done now travels through with
    // cluster='Done', so its proposal must travel with it.
    //
    // The sibling running task matters: pruneCompletedArcs() strips Done rows
    // whose arc has no on-screen task, so a lone done row would be pruned from
    // `tasks` (though its proposal is collected before the prune). Sharing the
    // proposal makes the arc active and keeps the Done row addressable.
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertSlicedTask(qc, 't-done', 'done', 'p-done')
    await insertSlicedTask(qc, 't-running', 'running', 'p-done')
    qc.close()

    const sc = createClient({ url: `file:${stateDbPath}` })
    await insertProposal(sc, 'p-done')
    sc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBodyWithProposals

    expect(body.proposals.map((p) => p.id)).toContain('p-done')
    expect(body.tasks.find((t) => t.id === 't-done')?.cluster).toBe('Done')
  })

  it('prunes a done task whose arc has no on-screen sibling, but still emits its proposal', async () => {
    // pruneCompletedArcs() in orchestrator/src/core/daemon/view/progress.ts:
    // Done rows are arc METADATA only, so a fully-completed arc ships no task
    // rows at all (the repo it was written against shipped 2015/2086 rows and
    // ~10 MB per poll without this). The proposal id set is built before the
    // prune, so the proposal node survives.
    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertSlicedTask(qc, 't-done-alone', 'done', 'p-done-alone')
    qc.close()

    const sc = createClient({ url: `file:${stateDbPath}` })
    await insertProposal(sc, 'p-done-alone')
    sc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBodyWithProposals

    expect(body.tasks.find((t) => t.id === 't-done-alone')).toBeUndefined()
    expect(body.proposals.map((p) => p.id)).toContain('p-done-alone')
  })
})

// ---------------------------------------------------------------------------
// Failed tasks are always in scope — no recency gate
// ---------------------------------------------------------------------------

describe('GET /api/progress — all failed tasks are always in scope', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let queueDbPath: string

  beforeEach(async () => {
    repo = setupRepo()
    queueDbPath = resolve(repo, '.mars/mars.db')
    const qc = await createQueueSchema(queueDbPath)
    qc.close()
    const sc = await createStateSchema(resolve(repo, '.mars/mars.db'))
    sc.close()

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

  it('includes all failed tasks regardless of age', async () => {
    const now = Date.now()
    const twoYearsAgo = new Date(now - 2 * 365 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date(now - 10 * 60 * 1000).toISOString()

    const qc = createClient({ url: `file:${queueDbPath}` })
    await insertTask(qc, 't-failed-ancient', 'failed', twoYearsAgo)
    await insertTask(qc, 't-failed-recent', 'failed', recent)
    qc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBody
    const ids = body.tasks.map((t) => t.id)

    expect(ids).toContain('t-failed-ancient')
    expect(ids).toContain('t-failed-recent')
    const counts = countBy(body.tasks)
    expect(counts.Failed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// failedOpen aggregate counts per-origin — recovery tasks (fix_for_task_id IS
// NOT NULL) must not inflate the FAILED stat
// ---------------------------------------------------------------------------

interface ProgressBodyWithAggregates extends ProgressBody {
  aggregates: { doneToday: number; doneTotal: number; failedOpen: number }
}

describe('GET /api/progress — failedOpen aggregate excludes recovery tasks', () => {
  let repo: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string
  let queueDbPath: string

  const createSchemaWithFixForTaskId = async (path: string): Promise<Client> => {
    const c = createClient({ url: `file:${path}` })
    await c.execute(`CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_functional TEXT,
      plan_technical TEXT,
      branch TEXT,
      worktree_path TEXT,
      error TEXT,
      drop_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      fix_for_task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`)
    return c
  }

  beforeEach(async () => {
    repo = setupRepo()
    queueDbPath = resolve(repo, '.mars/mars.db')
    const qc = await createSchemaWithFixForTaskId(queueDbPath)
    const sc = await createStateSchema(resolve(repo, '.mars/mars.db'))
    qc.close()
    sc.close()

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

  it('counts only origin failures — a failed recovery does not add to failedOpen', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    // Origin task: failed, fix_for_task_id IS NULL
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, retry_count, created_at, updated_at)
            VALUES (?, ?, 'failed', NULL, 0, ?, ?)`,
      args: ['origin-1', 'origin task', new Date().toISOString(), new Date().toISOString()],
    })
    // Recovery task: failed, fix_for_task_id IS NOT NULL
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, retry_count, created_at, updated_at)
            VALUES (?, ?, 'failed', ?, 0, ?, ?)`,
      args: ['fix-1', 'recovery task', 'origin-1', new Date().toISOString(), new Date().toISOString()],
    })
    qc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ProgressBodyWithAggregates

    // Both tasks appear in the Failed cluster (the task list is unfiltered)
    const counts = countBy(body.tasks)
    expect(counts.Failed).toBe(2)

    // But the aggregate only counts the origin — failedOpen must be 1, not 2
    expect(body.aggregates.failedOpen).toBe(1)
  })

  it('counts each distinct origin separately when multiple origins fail', async () => {
    const qc = createClient({ url: `file:${queueDbPath}` })
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, retry_count, created_at, updated_at)
            VALUES (?, ?, 'failed', NULL, 0, ?, ?)`,
      args: ['origin-a', 'task a', new Date().toISOString(), new Date().toISOString()],
    })
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, retry_count, created_at, updated_at)
            VALUES (?, ?, 'failed', NULL, 0, ?, ?)`,
      args: ['origin-b', 'task b', new Date().toISOString(), new Date().toISOString()],
    })
    // Recovery for origin-a
    await qc.execute({
      sql: `INSERT INTO tasks (id, prompt, status, fix_for_task_id, retry_count, created_at, updated_at)
            VALUES (?, ?, 'failed', ?, 0, ?, ?)`,
      args: ['fix-a', 'fix for a', 'origin-a', new Date().toISOString(), new Date().toISOString()],
    })
    qc.close()

    const res = await fetch(`${baseUrl}/api/progress`)
    const body = (await res.json()) as ProgressBodyWithAggregates

    // 3 rows in the cluster but only 2 are origins
    expect(body.aggregates.failedOpen).toBe(2)
  })
})
