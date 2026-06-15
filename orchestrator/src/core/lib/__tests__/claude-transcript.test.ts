import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
}

interface TranscriptModule {
  encodeClaudeCwd: typeof import('../claude-transcript').encodeClaudeCwd
  resolveTranscriptLocationsForTask: typeof import('../claude-transcript').resolveTranscriptLocationsForTask
  readTranscript: typeof import('../claude-transcript').readTranscript
  readAllTranscriptsForTask: typeof import('../claude-transcript').readAllTranscriptsForTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-claude-transcript-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; tx: TranscriptModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const tx = (await import('../claude-transcript')) as unknown as TranscriptModule
  return { q, tx }
}

const writeTranscriptFile = (
  homeDir: string,
  encodedCwd: string,
  sessionId: string,
  lines: string[],
): string => {
  const dir = resolve(homeDir, '.claude', 'projects', encodedCwd)
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `${sessionId}.jsonl`)
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

const setSessionIds = async (
  q: QueueModule,
  taskId: string,
  ids: string[],
): Promise<void> => {
  // Write directly to the junction table (legacy tasks.claude_session_ids column is dropped).
  await q.resolveQueueClient().execute({
    sql: `DELETE FROM task_claude_sessions WHERE task_id = ?`,
    args: [taskId],
  })
  for (let i = 0; i < ids.length; i++) {
    await q.resolveQueueClient().execute({
      sql: `INSERT OR IGNORE INTO task_claude_sessions (task_id, session_id, position) VALUES (?, ?, ?)`,
      args: [taskId, ids[i], i],
    })
  }
}

const setWorktreePath = async (
  q: QueueModule,
  taskId: string,
  worktreePath: string,
): Promise<void> => {
  await q.resolveQueueClient().execute({
    sql: `UPDATE tasks SET worktree_path = ? WHERE id = ?`,
    args: [worktreePath, taskId],
  })
}

describe('encodeClaudeCwd', () => {
  it('replaces every / and . with - (matches Claude Code on-disk dir naming)', async () => {
    const repo = setupRepo()
    try {
      const { tx } = await loadModules(repo)
      // Plain ASCII path — only slashes are rewritten.
      expect(tx.encodeClaudeCwd('/foo/bar')).toBe('-foo-bar')
      // A `/.mars/` segment collapses to `--mars-` (the leading dot of
      // the dot-segment becomes a second dash). This was the original
      // bug — the resolver looked under `-Users-...-.mars-...` while
      // Claude Code stored the transcript under `-Users-...--mars-...`.
      expect(
        tx.encodeClaudeCwd('/Users/x/project/.mars/worktrees/mars-abc'),
      ).toBe('-Users-x-project--mars-worktrees-mars-abc')
      // Mid-segment dots collapse too (empirically verified against a
      // real `/private/tmp/mars-test-dot.encode/sub` run).
      expect(tx.encodeClaudeCwd('/private/tmp/dot.in.middle')).toBe(
        '-private-tmp-dot-in-middle',
      )
      // Multiple consecutive dot-segments along the same path.
      expect(
        tx.encodeClaudeCwd('/Users/me/.cache/fleet/.mars/worktrees/x'),
      ).toBe('-Users-me--cache-fleet--mars-worktrees-x')
      expect(tx.encodeClaudeCwd('/')).toBe('-')
    } finally {
      delete process.env.MARS_REPO
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('resolveTranscriptLocationsForTask', () => {
  let repo: string
  let homeDir: string

  beforeEach(() => {
    repo = setupRepo()
    homeDir = mkdtempSync(resolve(tmpdir(), 'mars-fake-home-'))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('returns one location per session id, preserving order', async () => {
    const { q, tx } = await loadModules(repo)
    const t = await q.enqueueTask('p', undefined, { skipTriage: true })
    const worktreePath = '/tmp/wt-abc'
    await setWorktreePath(q, t.id, worktreePath)
    await setSessionIds(q, t.id, ['sess-a', 'sess-b'])

    const encoded = tx.encodeClaudeCwd(worktreePath)
    writeTranscriptFile(homeDir, encoded, 'sess-a', ['{"type":"user"}'])
    // sess-b file intentionally absent

    const locations = await tx.resolveTranscriptLocationsForTask(t.id, { homeDir })
    expect(locations).toHaveLength(2)
    expect(locations[0].sessionId).toBe('sess-a')
    expect(locations[0].exists).toBe(true)
    expect(locations[0].path).toContain(encoded)
    expect(locations[0].path.endsWith('sess-a.jsonl')).toBe(true)
    expect(locations[1].sessionId).toBe('sess-b')
    expect(locations[1].exists).toBe(false)
  })

  it('returns empty array when the task has no session ids recorded', async () => {
    const { q, tx } = await loadModules(repo)
    const t = await q.enqueueTask('p', undefined, { skipTriage: true })
    await setWorktreePath(q, t.id, '/tmp/wt')
    const locations = await tx.resolveTranscriptLocationsForTask(t.id, { homeDir })
    expect(locations).toEqual([])
  })

  it('returns empty array when worktree path is null (legacy row)', async () => {
    const { q, tx } = await loadModules(repo)
    const t = await q.enqueueTask('p', undefined, { skipTriage: true })
    await setSessionIds(q, t.id, ['sess-only'])
    const locations = await tx.resolveTranscriptLocationsForTask(t.id, { homeDir })
    expect(locations).toEqual([])
  })

  it('returns empty array when the task id is unknown', async () => {
    const { tx } = await loadModules(repo)
    const locations = await tx.resolveTranscriptLocationsForTask('not-a-task', {
      homeDir,
    })
    expect(locations).toEqual([])
  })

  it('falls back to enumerating *.jsonl when the stored session id is absent but the dir holds other transcripts', async () => {
    const { q, tx } = await loadModules(repo)
    const t = await q.enqueueTask('p', undefined, { skipTriage: true })
    // A real Mars worktree-style path so the encoder change is exercised
    // end-to-end (the `/.mars/` segment must encode to `--mars-`).
    const worktreePath = '/tmp/proj/.mars/worktrees/mars-xyz'
    await setWorktreePath(q, t.id, worktreePath)
    await setSessionIds(q, t.id, ['stored-but-missing'])

    const encoded = tx.encodeClaudeCwd(worktreePath)
    expect(encoded).toBe('-tmp-proj--mars-worktrees-mars-xyz')

    // Write a real transcript file under a DIFFERENT session id — this
    // is the on-disk reality for tasks whose stored id drifted from
    // Claude Code's rotated id.
    writeTranscriptFile(homeDir, encoded, 'real-on-disk', [
      '{"type":"user"}',
    ])

    const locations = await tx.resolveTranscriptLocationsForTask(t.id, { homeDir })
    expect(locations).toHaveLength(2)
    // First entry: the stored id, marked exists=false so callers can
    // still see the miss.
    expect(locations[0]).toMatchObject({
      sessionId: 'stored-but-missing',
      exists: false,
    })
    // Second entry: the orphan transcript discovered by enumeration.
    expect(locations[1]).toMatchObject({
      sessionId: 'real-on-disk',
      exists: true,
    })
    expect(locations[1].path.endsWith('real-on-disk.jsonl')).toBe(true)
  })

  it('readAllTranscriptsForTask streams events from the enumeration-fallback orphan transcript', async () => {
    const { q, tx } = await loadModules(repo)
    const t = await q.enqueueTask('p', undefined, { skipTriage: true })
    const worktreePath = '/tmp/proj/.mars/worktrees/mars-orphan'
    await setWorktreePath(q, t.id, worktreePath)
    await setSessionIds(q, t.id, ['stored-only-no-file'])

    const encoded = tx.encodeClaudeCwd(worktreePath)
    writeTranscriptFile(homeDir, encoded, 'orphan-sid', [
      '{"type":"user","n":1}',
      '{"type":"assistant","n":2}',
    ])

    const events: number[] = []
    for await (const ev of tx.readAllTranscriptsForTask(t.id, { homeDir })) {
      const raw = ev.raw as { n?: number }
      if (typeof raw.n === 'number') events.push(raw.n)
    }
    // The stored session id has no file (skipped), but the orphan is
    // enumerated and read end-to-end. Without the fallback, this would
    // return [] and deep-reflect would report "0 events".
    expect(events).toEqual([1, 2])
  })
})

describe('readTranscript', () => {
  let repo: string
  let homeDir: string

  beforeEach(() => {
    repo = setupRepo()
    homeDir = mkdtempSync(resolve(tmpdir(), 'mars-fake-home-'))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('yields parsed events with 1-based line numbers', async () => {
    const { tx } = await loadModules(repo)
    const path = writeTranscriptFile(homeDir, '-foo', 'sess', [
      '{"type":"user","line":1}',
      '{"type":"assistant","line":2}',
      '{"type":"tool_use","name":"Read"}',
    ])
    const out: Array<{ line: number; type: string }> = []
    for await (const ev of tx.readTranscript(path)) {
      const raw = ev.raw as { type?: string }
      out.push({ line: ev.line, type: String(raw.type ?? '') })
    }
    expect(out).toEqual([
      { line: 1, type: 'user' },
      { line: 2, type: 'assistant' },
      { line: 3, type: 'tool_use' },
    ])
  })

  it('skips malformed lines and reports them via callback', async () => {
    const { tx } = await loadModules(repo)
    const path = writeTranscriptFile(homeDir, '-foo', 'sess', [
      '{"type":"ok","n":1}',
      'not-json',
      '{"type":"ok","n":2}',
      '{partial',
    ])
    const reported: Array<{ line: number; err: unknown }> = []
    const events: number[] = []
    for await (const ev of tx.readTranscript(path, {
      onMalformed: (line, err) => reported.push({ line, err }),
    })) {
      events.push(ev.line)
    }
    expect(events).toEqual([1, 3])
    expect(reported.map((r) => r.line)).toEqual([2, 4])
    for (const r of reported) {
      expect(r.err).toBeInstanceOf(Error)
    }
  })

  it('yields zero events for an empty file', async () => {
    const { tx } = await loadModules(repo)
    const path = writeTranscriptFile(homeDir, '-foo', 'sess', [])
    const out: unknown[] = []
    for await (const ev of tx.readTranscript(path)) {
      out.push(ev)
    }
    // writeTranscriptFile inserts a trailing newline; the blank line is
    // skipped (empty after trim).
    expect(out).toEqual([])
  })

  it('yields zero events without throwing when the file does not exist', async () => {
    const { tx } = await loadModules(repo)
    const out: unknown[] = []
    for await (const ev of tx.readTranscript(resolve(homeDir, 'nope.jsonl'))) {
      out.push(ev)
    }
    expect(out).toEqual([])
  })
})

describe('readAllTranscriptsForTask', () => {
  let repo: string
  let homeDir: string

  beforeEach(() => {
    repo = setupRepo()
    homeDir = mkdtempSync(resolve(tmpdir(), 'mars-fake-home-'))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('streams events from multiple sessions in session order, tagging sessionIndex', async () => {
    const { q, tx } = await loadModules(repo)
    const t = await q.enqueueTask('p', undefined, { skipTriage: true })
    const worktreePath = '/tmp/wt-multi'
    await setWorktreePath(q, t.id, worktreePath)
    await setSessionIds(q, t.id, ['sess-1', 'sess-2'])

    const encoded = tx.encodeClaudeCwd(worktreePath)
    writeTranscriptFile(homeDir, encoded, 'sess-1', [
      '{"type":"user","n":1}',
      '{"type":"assistant","n":2}',
    ])
    writeTranscriptFile(homeDir, encoded, 'sess-2', [
      '{"type":"user","n":3}',
    ])

    const collected: Array<{ sessionIndex: number; n: number }> = []
    for await (const ev of tx.readAllTranscriptsForTask(t.id, { homeDir })) {
      const raw = ev.raw as { n?: number }
      collected.push({ sessionIndex: ev.sessionIndex, n: raw.n ?? -1 })
    }
    expect(collected).toEqual([
      { sessionIndex: 0, n: 1 },
      { sessionIndex: 0, n: 2 },
      { sessionIndex: 1, n: 3 },
    ])
  })

  it('silently skips sessions whose JSONL file is missing on disk', async () => {
    const { q, tx } = await loadModules(repo)
    const t = await q.enqueueTask('p', undefined, { skipTriage: true })
    const worktreePath = '/tmp/wt-missing'
    await setWorktreePath(q, t.id, worktreePath)
    await setSessionIds(q, t.id, ['gone', 'present'])

    const encoded = tx.encodeClaudeCwd(worktreePath)
    writeTranscriptFile(homeDir, encoded, 'present', [
      '{"type":"user","n":42}',
    ])

    const out: Array<{ sessionIndex: number; n: number }> = []
    for await (const ev of tx.readAllTranscriptsForTask(t.id, { homeDir })) {
      const raw = ev.raw as { n?: number }
      out.push({ sessionIndex: ev.sessionIndex, n: raw.n ?? -1 })
    }
    expect(out).toEqual([{ sessionIndex: 1, n: 42 }])
  })
})
