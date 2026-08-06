import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  upsertTranscript: typeof import('../../queue').upsertTranscript
  capConversationJson: typeof import('../../queue').capConversationJson
}

interface DeepQueryModule {
  loadDeepReflectArc: typeof import('../deep-reflect-query').loadDeepReflectArc
  listDeepReflectArcCandidates: typeof import('../deep-reflect-query').listDeepReflectArcCandidates
  loadSessionArcs: typeof import('../deep-reflect-query').loadSessionArcs
}

interface DbModule {
  closeAllDbs: typeof import('../db').closeAllDbs
}

/**
 * Local mirror of encodeClaudeCwd (claude-transcript.ts). Kept inline to
 * avoid importing the transcript module in loadModules — importing it from
 * inside loadModules (after vi.resetModules) causes module-singleton
 * interference that races the DB initialisation of tests in the same file.
 */
const encodeCwd = (cwd: string): string => cwd.replace(/[/.]/g, '-')

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-deep-reflect-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; dq: DeepQueryModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const dq = (await import('../deep-reflect-query')) as unknown as DeepQueryModule
  return { q, dq }
}

/** Write a fake transcript JSONL file under homeDir/<encodedCwd>/<sessionId>.jsonl */
const writeTranscriptFile = (
  homeDir: string,
  encodedCwd: string,
  sessionId: string,
  lines: string[],
): void => {
  const dir = resolve(homeDir, '.claude', 'projects', encodedCwd)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n')
}

describe('listDeepReflectArcCandidates', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty array when DB is empty', async () => {
    const { dq } = await loadModules(repo)
    const result = await dq.listDeepReflectArcCandidates({
      withTranscriptOnly: false,
    })
    expect(result).toEqual([])
  })

  it('withTranscriptOnly: false returns arcs without transcripts', async () => {
    const { q, dq } = await loadModules(repo)
    // Task with no transcript
    const noTranscript = await q.enqueueTask('no transcript task', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = ? WHERE id = ?`,
      args: ['done', noTranscript.id],
    })

    // withTranscriptOnly: true (default) should exclude it
    const withOnly = await dq.listDeepReflectArcCandidates({
      withTranscriptOnly: true,
    })
    expect(withOnly.find((a) => a.originId === noTranscript.id)).toBeUndefined()

    // withTranscriptOnly: false should include it
    const withAll = await dq.listDeepReflectArcCandidates({
      withTranscriptOnly: false,
    })
    const found = withAll.find((a) => a.originId === noTranscript.id)
    expect(found).toBeDefined()
    expect(found?.taskCount).toBe(1)
    expect(found?.statusMix.done).toBe(1)
  })

  it('withTranscriptOnly: false includes ad-hoc single-task arcs alongside transcript arcs', async () => {
    const { q, dq } = await loadModules(repo)

    // Arc with transcript
    const withTx = await q.enqueueTask('task with transcript', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = ? WHERE id = ?`,
      args: ['done', withTx.id],
    })
    await q.upsertTranscript({ taskId: withTx.id, conversationJson: '[]' })

    // Arc without transcript (ad-hoc)
    const noTx = await q.enqueueTask('ad-hoc task no transcript', undefined, {
      skipTriage: true,
    })
    await q.resolveQueueClient().execute({
      sql: `UPDATE tasks SET status = ? WHERE id = ?`,
      args: ['done', noTx.id],
    })

    const all = await dq.listDeepReflectArcCandidates({
      limit: 100,
      withTranscriptOnly: false,
    })
    const ids = all.map((a) => a.originId)
    expect(ids).toContain(withTx.id)
    expect(ids).toContain(noTx.id)
  })

  it('limit is respected', async () => {
    const { q, dq } = await loadModules(repo)
    for (let i = 0; i < 5; i++) {
      const t = await q.enqueueTask(`task ${i}`, undefined, { skipTriage: true })
      await q.resolveQueueClient().execute({
        sql: `UPDATE tasks SET status = ? WHERE id = ?`,
        args: ['done', t.id],
      })
    }
    const result = await dq.listDeepReflectArcCandidates({
      limit: 3,
      withTranscriptOnly: false,
    })
    expect(result.length).toBeLessThanOrEqual(3)
  })
})

describe('loadDeepReflectArc — durable transcript read path', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns durable transcript events from task_durable_transcripts when no JSONL file exists on disk', async () => {
    // loadDeepReflectArc reads from task_durable_transcripts (compressed BLOB)
    // when no streaming chunks and no on-disk JSONL are available.
    const { q, dq } = await loadModules(repo)

    // Create a task. By default it has no claude_session_ids, so the
    // filesystem fallback (readAllTranscriptsForTask) returns empty.
    const task = await q.enqueueTask('durable transcript test', undefined, {
      skipTriage: true,
    })

    // Write a compressed durable transcript via upsertTranscript, which now
    // stores to task_durable_transcripts instead of step_ended payloads.
    const events = [
      { type: 'assistant', content: 'durable reply from task_durable_transcripts' },
    ]
    await q.upsertTranscript({ taskId: task.id, conversationJson: JSON.stringify(events) })

    const arc = await dq.loadDeepReflectArc(task.id)
    expect(arc).not.toBeNull()
    const taskEntry = arc!.tasks[0]
    expect(taskEntry.conversation).toHaveLength(1)
    expect(taskEntry.conversation[0].type).toBe('assistant')
    expect(taskEntry.hasTranscript).toBe(true)
    expect(taskEntry.transcriptNotes).toHaveLength(0)
  })
})

describe('capConversationJson', () => {
  it('passes through small payloads unchanged', async () => {
    const repo = setupRepo()
    try {
      const { q } = await loadModules(repo)
      const small = JSON.stringify([{ a: 1 }])
      expect(q.capConversationJson(small)).toBe(small)
    } finally {
      delete process.env.MARS_REPO
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('drops the middle and inserts a marker for oversized payloads', async () => {
    const repo = setupRepo()
    try {
      const { q } = await loadModules(repo)
      const big = 'x'.repeat(3 * 1024 * 1024)
      const out = q.capConversationJson(big)
      expect(out.length).toBeLessThan(big.length)
      expect(out).toMatch(/"truncated":true/)
      expect(out).toMatch(/"skippedBytes":/)
    } finally {
      delete process.env.MARS_REPO
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ── Foreground session slice ──────────────────────────────────────────────────

describe('loadDeepReflectArc — foreground session slice', () => {
  let repo: string
  let homeDir: string

  beforeEach(() => {
    repo = setupRepo()
    homeDir = mkdtempSync(resolve(tmpdir(), 'mars-fake-home-drq-'))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_REFLECT_DISABLED
    rmSync(repo, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('includes messages inside the time window and excludes messages far outside it', async () => {
    const { q, dq } = await loadModules(repo)

    // A fake repo root that's distinct from the test repo so we can
    // write transcript files to a known location.
    const fakeRepoRoot = '/fake/foreground-repo'
    const sessionId = 'foreground-session-abc123'

    // Enqueue a task that carries the foreground session id.
    const task = await q.enqueueTask('implement feature X', undefined, {
      skipTriage: true,
      originSessionId: sessionId,
    })

    // Record a cli-invocation trace event that matches the session id,
    // timestamped at task.createdAt (the closest possible anchor).
    const anchorIso = task.createdAt
    const anchorMs = new Date(anchorIso).getTime()
    await q.resolveQueueClient().execute({
      sql: `INSERT INTO trace_events (id, timestamp, kind, severity, payload)
            VALUES (?, ?, 'cli-invocation', 'info', ?)`,
      args: [
        'cli-inv-foreground-abc123',
        anchorMs,
        JSON.stringify({
          originSessionId: sessionId,
          command: 'task add',
          flags: { '--priority': '2' },
          exitCode: 0,
          durationMs: 215,
        }),
      ],
    })

    // Write a fixture JSONL file with events at three different timestamps:
    //   oldMsg    — 60 min before anchor (OUTSIDE the 30-min window, excluded)
    //   recentMsg — 5 min before anchor  (INSIDE the window, included)
    //   afterMsg  — 2 min after anchor   (INSIDE the window, included)
    const encodedRoot = encodeCwd(fakeRepoRoot)
    writeTranscriptFile(homeDir, encodedRoot, sessionId, [
      JSON.stringify({
        type: 'user',
        timestamp: new Date(anchorMs - 60 * 60 * 1000).toISOString(),
        message: 'old unrelated message',
      }),
      JSON.stringify({
        type: 'user',
        timestamp: new Date(anchorMs - 5 * 60 * 1000).toISOString(),
        message: 'should we implement feature X?',
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(anchorMs + 2 * 60 * 1000).toISOString(),
        message: 'yes, enqueuing it now',
      }),
    ])

    const arc = await dq.loadDeepReflectArc(task.id, {
      homeDir,
      repoRoot: fakeRepoRoot,
    })

    expect(arc).not.toBeNull()
    expect(arc!.operatorContext).not.toBeNull()
    const ctx = arc!.operatorContext!

    // Only the two events inside the [anchor-30min, anchor+5min] window.
    expect(ctx.messages).toHaveLength(2)
    expect(ctx.messages[0].type).toBe('user')
    expect(ctx.messages[1].type).toBe('assistant')
    // The old message must NOT be present.
    expect(
      ctx.messages.every(
        (m) =>
          (m as { message?: string }).message !== 'old unrelated message',
      ),
    ).toBe(true)
    // Anchor was derived from cli-invocation.
    expect(ctx.windowKind).toBe('cli-invocation')
    expect(ctx.note).toBeNull()
    expect(ctx.sessionId).toBe(sessionId)
  })

  it('falls back to last-N messages when transcript events have no timestamps', async () => {
    const { q, dq } = await loadModules(repo)

    const fakeRepoRoot = '/fake/no-timestamps-repo'
    const sessionId = 'no-ts-session-xyz'

    const task = await q.enqueueTask('refactor module Y', undefined, {
      skipTriage: true,
      originSessionId: sessionId,
    })

    // Write 60 events without timestamp fields — only the last 50 should be kept.
    const encodedRoot = encodeCwd(fakeRepoRoot)
    const lines = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({ type: 'user', n: i }),
    )
    writeTranscriptFile(homeDir, encodedRoot, sessionId, lines)

    const arc = await dq.loadDeepReflectArc(task.id, {
      homeDir,
      repoRoot: fakeRepoRoot,
    })

    expect(arc).not.toBeNull()
    const ctx = arc!.operatorContext!
    expect(ctx.messages).toHaveLength(50)
    // The last 50: n=10..59
    expect((ctx.messages[0] as { n?: number }).n).toBe(10)
    expect((ctx.messages[49] as { n?: number }).n).toBe(59)
    expect(ctx.windowKind).toBe('created-at-fallback')
  })

  it('returns null operatorContext when task has no origin_session_id', async () => {
    const { q, dq } = await loadModules(repo)

    // Enqueue WITHOUT an originSessionId.
    const task = await q.enqueueTask('standalone task', undefined, {
      skipTriage: true,
    })

    const arc = await dq.loadDeepReflectArc(task.id, { homeDir })
    expect(arc).not.toBeNull()
    expect(arc!.operatorContext).toBeNull()
  })

  it('returns operatorContext with windowKind=none when the transcript file is absent', async () => {
    const { q, dq } = await loadModules(repo)

    const sessionId = 'missing-file-session'
    const task = await q.enqueueTask('task with missing transcript', undefined, {
      skipTriage: true,
      originSessionId: sessionId,
    })

    // Do NOT write any transcript file — the file is absent.
    const arc = await dq.loadDeepReflectArc(task.id, {
      homeDir,
      repoRoot: '/fake/no-file-repo',
    })

    expect(arc).not.toBeNull()
    const ctx = arc!.operatorContext!
    expect(ctx.messages).toHaveLength(0)
    expect(ctx.windowKind).toBe('none')
    expect(ctx.note).toMatch(/not found/)
    expect(ctx.sessionId).toBe(sessionId)
  })

  it('suppresses operatorContext when MARS_REFLECT_DISABLED=1', async () => {
    const { q, dq } = await loadModules(repo)
    process.env.MARS_REFLECT_DISABLED = '1'

    const fakeRepoRoot = '/fake/disabled-repo'
    const sessionId = 'disabled-session-999'

    const task = await q.enqueueTask('disabled reflect task', undefined, {
      skipTriage: true,
      originSessionId: sessionId,
    })

    // Write a valid transcript — should NOT be read because reflect is disabled.
    const encodedRoot = encodeCwd(fakeRepoRoot)
    writeTranscriptFile(homeDir, encodedRoot, sessionId, [
      JSON.stringify({ type: 'user', timestamp: task.createdAt, message: 'hi' }),
    ])

    const arc = await dq.loadDeepReflectArc(task.id, {
      homeDir,
      repoRoot: fakeRepoRoot,
    })

    expect(arc).not.toBeNull()
    // operatorContext must be null when reflection is disabled.
    expect(arc!.operatorContext).toBeNull()
  })
})

describe('loadSessionArcs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(async () => {
    // Close PGlite BEFORE the next vi.resetModules() call so that WASM
    // allocations are returned to the free list rather than orphaned. Without
    // this, successive DDL-heavy tests exhaust the shared WASM heap and
    // contaminate other test suites in the same process.
    const db = (await import('../db')) as unknown as DbModule
    await db.closeAllDbs()
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null for a session with no tasks', async () => {
    const { dq } = await loadModules(repo)
    const result = await dq.loadSessionArcs('session-with-no-tasks')
    expect(result).toBeNull()
  })

  it('returns originIds for a multi-task session in creation order', async () => {
    const { q, dq } = await loadModules(repo)
    const sessionId = 'multi-task-session-abc'
    const task1 = await q.enqueueTask('first task', undefined, {
      skipTriage: true,
      originSessionId: sessionId,
    })
    const task2 = await q.enqueueTask('second task', undefined, {
      skipTriage: true,
      originSessionId: sessionId,
    })
    const result = await dq.loadSessionArcs(sessionId)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe(sessionId)
    expect(result!.originIds).toContain(task1.id)
    expect(result!.originIds).toContain(task2.id)
    const idx1 = result!.originIds.indexOf(task1.id)
    const idx2 = result!.originIds.indexOf(task2.id)
    expect(idx1).toBeLessThan(idx2)
  })

  it('throws on a store query failure instead of silently returning null', async () => {
    const { q, dq } = await loadModules(repo)
    const sessionId = 'session-for-failure-test'
    // Warm cachedDefaultStore so getDefaultTaskStore() returns immediately
    // without calling ensureSchema() (which would recreate renamed columns).
    await q.enqueueTask('seed task to prime the store cache', undefined, { skipTriage: true })
    // Rename column to induce a SQL error without DROP TABLE CASCADE (which
    // would corrupt the PGlite WASM heap and contaminate other tests).
    await q.resolveQueueClient().execute({
      sql: 'ALTER TABLE tasks RENAME COLUMN origin_session_id TO origin_session_id_renamed',
    })
    await expect(dq.loadSessionArcs(sessionId)).rejects.toThrow()
  })
})
