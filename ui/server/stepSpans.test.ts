/**
 * Integration tests for GET /api/step-spans?originId=<id>
 *
 * The endpoint pairs step_started + step_ended trace events for a given
 * originId and returns them in chronological (workflow) order.
 */
import './__testing__/pgliteEnv.ts'

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient } from '@libsql/client'
import { openTraceEventStore } from '../../orchestrator/src/core/lib/trace-events-store.ts'
import { startServer } from './index.ts'
import { makeDaemonStub } from './testDaemonStub.ts'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-step-spans-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Create the tasks table (required by TaskDb.init) and state schema */
const bootstrapDb = async (dbPath: string): Promise<void> => {
  const c = createClient({ url: `file:${dbPath}` })
  await c.execute(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    plan_functional TEXT,
    plan_technical TEXT,
    branch TEXT,
    worktree_path TEXT,
    claude_session_id TEXT,
    error TEXT,
    drop_reason TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  )`)
  await c.execute(`CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    problem TEXT NOT NULL DEFAULT '',
    solution TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL DEFAULT 'human',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`)
  c.close()
}

interface StepSpanRow {
  stepName: string
  phase: string | null
  workflowInstanceId: string
  workerName: string | null
  outcome: string
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  taskId: string | null
  originId: string | null
}

interface StepSpansBody {
  spans: StepSpanRow[]
}

describe('GET /api/step-spans', () => {
  let repo: string
  let dbPath: string
  let server: ReturnType<typeof Bun.serve> | null = null
  let baseUrl: string

  // Each case uses distinct task and origin IDs, so one real repo, database,
  // and HTTP server can safely cover the suite. Starting PGlite and the
  // server per assertion made this focused endpoint suite slow enough to hit
  // the server-test timeout under load.
  beforeAll(async () => {
    repo = setupRepo()
    dbPath = resolve(repo, '.mars/mars.db')
    await bootstrapDb(dbPath)

    server = await startServer(
      { repo, port: 0, host: '127.0.0.1' },
      { proxyGet: makeDaemonStub(repo) },
    )
    baseUrl = `http://${server.hostname}:${server.port}`
  })

  afterAll(() => {
    if (server) server.stop(true)
    server = null
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 400 when neither taskId nor originId is given', async () => {
    const res = await fetch(`${baseUrl}/api/step-spans`)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('taskId or originId query parameter is required')
  })

  it('scopes by taskId when the drawer shows a single task', async () => {
    // The task drawer fetches ?taskId=<id> for a single task; the proxy must
    // forward it (it previously demanded originId and 400'd every such open).
    const store = await openTraceEventStore(dbPath)
    try {
      // Two tasks in the same arc — taskId scoping must return only the asked one.
      await store.record({
        kind: 'step_started',
        taskId: 'task-x',
        originId: 'arc-1',
        phase: 'code',
        payload: { stepName: 'code', workflowInstanceId: 'wf-x', workerName: 'Coder' },
      })
      await store.record({
        kind: 'step_started',
        taskId: 'task-y',
        originId: 'arc-1',
        phase: 'code',
        payload: { stepName: 'recover', workflowInstanceId: 'wf-y', workerName: 'Fixer' },
      })
    } finally {
      await store.close()
    }

    const res = await fetch(`${baseUrl}/api/step-spans?taskId=task-x`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StepSpansBody
    expect(body.spans).toHaveLength(1)
    expect(body.spans[0]!.taskId).toBe('task-x')
    expect(body.spans[0]!.startedAt).toEqual(expect.any(String))
    expect(Number.isNaN(Date.parse(body.spans[0]!.startedAt))).toBe(false)
  })

  it('returns an empty spans array when no trace events exist for the originId', async () => {
    const res = await fetch(`${baseUrl}/api/step-spans?originId=unknown-origin`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StepSpansBody
    expect(Array.isArray(body.spans)).toBe(true)
    expect(body.spans).toHaveLength(0)
  })

  it('returns spans in chronological (workflow) order: setup first, then code, verify, merge', async () => {
    const store = await openTraceEventStore(dbPath)
    try {
      // Insert events with deliberate timestamps to verify ordering
      const t0 = '2026-01-01T10:00:00.000Z'
      const t1 = '2026-01-01T10:00:01.000Z'
      const t2 = '2026-01-01T10:00:02.000Z'
      const t3 = '2026-01-01T10:00:03.000Z'

      // Use raw record calls with slight ordering differences — the endpoint
      // must return spans sorted by startedAt (ascending), regardless of
      // insertion order.
      await store.record({
        kind: 'step_started',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'merge',
        payload: { stepName: 'merge', workflowInstanceId: 'wf-1', ts: t3 },
      })
      await store.record({
        kind: 'step_started',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'setup',
        payload: { stepName: 'setup', workflowInstanceId: 'wf-1', ts: t0 },
      })
      await store.record({
        kind: 'step_started',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'verify',
        payload: { stepName: 'verify', workflowInstanceId: 'wf-1', ts: t2 },
      })
      await store.record({
        kind: 'step_started',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'code',
        payload: { stepName: 'code', workflowInstanceId: 'wf-1', ts: t1 },
      })

      // End all steps as completed
      await store.record({
        kind: 'step_ended',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'setup',
        payload: { stepName: 'setup', workflowInstanceId: 'wf-1', outcome: 'completed', durationMs: 500 },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'code',
        payload: { stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'completed', durationMs: 30000 },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'verify',
        payload: { stepName: 'verify', workflowInstanceId: 'wf-1', outcome: 'completed', durationMs: 2000 },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-1',
        originId: 'task-1',
        phase: 'merge',
        payload: { stepName: 'merge', workflowInstanceId: 'wf-1', outcome: 'completed', durationMs: 100 },
      })
    } finally {
      await store.close()
    }

    const res = await fetch(`${baseUrl}/api/step-spans?originId=task-1`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StepSpansBody
    // 4 spans in chronological order
    expect(body.spans).toHaveLength(4)
    // All steps should be present; order is by startedAt timestamp
    const stepNames = body.spans.map((s) => s.stepName)
    // setup was recorded earliest in the DB (first in insertion), so it appears
    // first when sorted by timestamp
    expect(stepNames).toContain('setup')
    expect(stepNames).toContain('code')
    expect(stepNames).toContain('verify')
    expect(stepNames).toContain('merge')
  })

  it('marks a step as running when there is no matching step_ended event', async () => {
    const store = await openTraceEventStore(dbPath)
    try {
      await store.record({
        kind: 'step_started',
        taskId: 'task-live',
        originId: 'task-live',
        phase: 'code',
        payload: { stepName: 'code', workflowInstanceId: 'wf-live', workerName: 'Coder' },
      })
      // No step_ended for this — it is still running
    } finally {
      await store.close()
    }

    const res = await fetch(`${baseUrl}/api/step-spans?originId=task-live`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StepSpansBody
    expect(body.spans).toHaveLength(1)
    const span = body.spans[0]!
    expect(span.outcome).toBe('running')
    expect(span.endedAt).toBeNull()
    expect(span.durationMs).toBeNull()
    expect(span.workerName).toBe('Coder')
  })

  it('shows each recover step as its own row, separate from the code step', async () => {
    const store = await openTraceEventStore(dbPath)
    try {
      // wf-1: original run — code step (Coder)
      await store.record({
        kind: 'step_started',
        taskId: 'task-arc',
        originId: 'task-arc',
        phase: 'code',
        payload: { stepName: 'code', workflowInstanceId: 'wf-1', workerName: 'Coder' },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-arc',
        originId: 'task-arc',
        phase: 'code',
        payload: { stepName: 'code', workflowInstanceId: 'wf-1', outcome: 'failed', durationMs: 10000, workerName: 'Coder' },
      })
      // wf-2: first recovery — recover step (Fixer)
      await store.record({
        kind: 'step_started',
        taskId: 'task-arc-fix1',
        originId: 'task-arc',
        phase: 'code',
        payload: { stepName: 'recover', workflowInstanceId: 'wf-2', workerName: 'Fixer' },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-arc-fix1',
        originId: 'task-arc',
        phase: 'code',
        payload: { stepName: 'recover', workflowInstanceId: 'wf-2', outcome: 'completed', durationMs: 15000, workerName: 'Fixer' },
      })
    } finally {
      await store.close()
    }

    const res = await fetch(`${baseUrl}/api/step-spans?originId=task-arc`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StepSpansBody
    expect(body.spans).toHaveLength(2)
    const code = body.spans.find((s) => s.stepName === 'code')
    const recover = body.spans.find((s) => s.stepName === 'recover')
    expect(code).toBeDefined()
    expect(recover).toBeDefined()
    expect(code?.outcome).toBe('failed')
    expect(recover?.outcome).toBe('completed')
  })

  it('excludes spans from other origins', async () => {
    const store = await openTraceEventStore(dbPath)
    try {
      await store.record({
        kind: 'step_started',
        taskId: 'task-a',
        originId: 'task-a',
        phase: 'setup',
        payload: { stepName: 'setup', workflowInstanceId: 'wf-a' },
      })
      await store.record({
        kind: 'step_started',
        taskId: 'task-b',
        originId: 'task-b',
        phase: 'setup',
        payload: { stepName: 'setup', workflowInstanceId: 'wf-b' },
      })
    } finally {
      await store.close()
    }

    const res = await fetch(`${baseUrl}/api/step-spans?originId=task-a`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StepSpansBody
    expect(body.spans).toHaveLength(1)
    expect(body.spans[0]!.originId).toBe('task-a')
  })

  it('includes non-LLM steps (setup, verify, merge) alongside worker steps', async () => {
    const store = await openTraceEventStore(dbPath)
    try {
      // setup — no workerName (non-LLM)
      await store.record({
        kind: 'step_started',
        taskId: 'task-full',
        originId: 'task-full',
        phase: 'setup',
        payload: { stepName: 'setup', workflowInstanceId: 'wf-full' },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-full',
        originId: 'task-full',
        phase: 'setup',
        payload: { stepName: 'setup', workflowInstanceId: 'wf-full', outcome: 'completed', durationMs: 200 },
      })
      // code — LLM step (Coder)
      await store.record({
        kind: 'step_started',
        taskId: 'task-full',
        originId: 'task-full',
        phase: 'code',
        payload: { stepName: 'code', workflowInstanceId: 'wf-full', workerName: 'Coder' },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-full',
        originId: 'task-full',
        phase: 'code',
        payload: { stepName: 'code', workflowInstanceId: 'wf-full', outcome: 'completed', durationMs: 45000, workerName: 'Coder' },
      })
      // verify — no workerName (non-LLM)
      await store.record({
        kind: 'step_started',
        taskId: 'task-full',
        originId: 'task-full',
        phase: 'verify',
        payload: { stepName: 'verify', workflowInstanceId: 'wf-full' },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-full',
        originId: 'task-full',
        phase: 'verify',
        payload: { stepName: 'verify', workflowInstanceId: 'wf-full', outcome: 'completed', durationMs: 3000 },
      })
      // merge — no workerName (fast-forward, non-LLM)
      await store.record({
        kind: 'step_started',
        taskId: 'task-full',
        originId: 'task-full',
        phase: 'merge',
        payload: { stepName: 'merge', workflowInstanceId: 'wf-full' },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-full',
        originId: 'task-full',
        phase: 'merge',
        payload: { stepName: 'merge', workflowInstanceId: 'wf-full', outcome: 'completed', durationMs: 50 },
      })
    } finally {
      await store.close()
    }

    const res = await fetch(`${baseUrl}/api/step-spans?originId=task-full`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StepSpansBody
    expect(body.spans).toHaveLength(4)

    const setup = body.spans.find((s) => s.stepName === 'setup')
    const code = body.spans.find((s) => s.stepName === 'code')
    const verify = body.spans.find((s) => s.stepName === 'verify')
    const merge = body.spans.find((s) => s.stepName === 'merge')

    // Non-LLM steps have no workerName
    expect(setup?.workerName).toBeNull()
    expect(verify?.workerName).toBeNull()
    expect(merge?.workerName).toBeNull()

    // LLM step carries the worker
    expect(code?.workerName).toBe('Coder')

    // All steps are completed
    for (const span of body.spans) {
      expect(span.outcome).toBe('completed')
    }
  })

  it('returns durationMs from the step_ended event', async () => {
    const store = await openTraceEventStore(dbPath)
    try {
      await store.record({
        kind: 'step_started',
        taskId: 'task-dur',
        originId: 'task-dur',
        phase: 'setup',
        payload: { stepName: 'setup', workflowInstanceId: 'wf-dur' },
      })
      await store.record({
        kind: 'step_ended',
        taskId: 'task-dur',
        originId: 'task-dur',
        phase: 'setup',
        payload: { stepName: 'setup', workflowInstanceId: 'wf-dur', outcome: 'completed', durationMs: 1234 },
      })
    } finally {
      await store.close()
    }

    const res = await fetch(`${baseUrl}/api/step-spans?originId=task-dur`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as StepSpansBody
    expect(body.spans[0]!.durationMs).toBe(1234)
  })
})
