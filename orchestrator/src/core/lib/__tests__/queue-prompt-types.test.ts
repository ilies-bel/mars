import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  listTasks: typeof import('../../queue').listTasks
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  coerceToString: typeof import('../../queue').coerceToString
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-prompt-types-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadQueue = async (repo: string): Promise<Queue> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const mod = await import('../../queue')
  await mod.migrateQueueSchema()
  return mod as unknown as Queue
}

describe('queue prompt type guards', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('enqueueTask accepts a UTF-8 string and stores it as TEXT', async () => {
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('hello world')
    expect(t.prompt).toBe('hello world')
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.prompt).toBe('hello world')
  })

  it('enqueueTask coerces a Buffer prompt to UTF-8 text', async () => {
    const q = await loadQueue(repo)
    const buf = Buffer.from('hello from buffer', 'utf8')
    const t = await q.enqueueTask(buf as unknown as string)
    expect(typeof t.prompt).toBe('string')
    expect(t.prompt).toBe('hello from buffer')
  })

  it('enqueueTask coerces a Uint8Array prompt to UTF-8 text', async () => {
    const q = await loadQueue(repo)
    const u8 = new TextEncoder().encode('hello from uint8')
    const t = await q.enqueueTask(u8 as unknown as string)
    expect(t.prompt).toBe('hello from uint8')
  })

  it('enqueueTask rejects non-string, non-bytes prompts', async () => {
    const q = await loadQueue(repo)
    await expect(q.enqueueTask(42 as unknown as string)).rejects.toThrow(
      /must be a string/,
    )
    await expect(q.enqueueTask(null as unknown as string)).rejects.toThrow(
      /must be a string/,
    )
    await expect(q.enqueueTask({ x: 1 } as unknown as string)).rejects.toThrow(
      /must be a string/,
    )
  })

  it('the prompt column is a typed TEXT column so blob prompts are unrepresentable', async () => {
    // On PostgreSQL the schema itself enforces text-ness (`prompt text NOT
    // NULL`), so the SQLite-era boot-time "heal blob prompts to TEXT" pass is
    // gone — a byte prompt is coerced at the enqueue boundary instead.
    const q = await loadQueue(repo)
    const t = await q.enqueueTask('seed', undefined, { skipTriage: true })

    const direct = q.resolveQueueClient()
    const col = await direct.execute(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = 'prompt'`,
    )
    expect((col.rows[0] as unknown as { data_type: string }).data_type).toBe('text')

    const row = await direct.execute({
      sql: `SELECT prompt FROM tasks WHERE id = ?`,
      args: [t.id],
    })
    expect((row.rows[0] as unknown as { prompt: unknown }).prompt).toBe('seed')

    // Idempotent: re-running the schema pass never disturbs stored text.
    await q.migrateQueueSchema()
    const again = await direct.execute({
      sql: `SELECT prompt FROM tasks WHERE id = ?`,
      args: [t.id],
    })
    expect((again.rows[0] as unknown as { prompt: unknown }).prompt).toBe('seed')
  })

  it('migrateQueueSchema creates task_transcripts with new streaming-chunk schema', async () => {
    // The old task_transcripts (with verify_output) was migrated to trace_events in
    // PRD 436f14c7 slice 5.  The schema now defines the table under the
    // new incremental-streaming shape (task_id, session_id, seq, chunk, ts) so
    // coder transcripts can be persisted durably during a run.
    const q = await loadQueue(repo)
    await q.migrateQueueSchema()
    const direct = q.resolveQueueClient()

    // Table must exist with the new schema.
    const tables = await direct.execute(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name = 'task_transcripts'`,
    )
    expect(tables.rows.length).toBe(1)

    // New schema has session_id column; old schema had verify_output.
    const cols = await direct.execute(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'task_transcripts'`,
    )
    const colNames = cols.rows.map(
      (r) => (r as unknown as { column_name: string }).column_name,
    )
    expect(colNames).toContain('session_id')
    expect(colNames).not.toContain('verify_output')

    // trace_events must also exist (migration ensures it).
    const traceTable = await direct.execute(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name = 'trace_events'`,
    )
    expect(traceTable.rows.length).toBe(1)
  })

  it('coerceToString decodes byte-shaped prompt values on the read path', async () => {
    // rowToTask funnels every prompt read through coerceToString, so a driver
    // that surfaces bytes (Buffer / Uint8Array / ArrayBuffer) still yields a
    // string to callers. The PG text column makes stored bytes unrepresentable,
    // so the decode seam is exercised directly.
    const q = await loadQueue(repo)
    expect(q.coerceToString(new Uint8Array([0x6f, 0x6b]), 'prompt')).toBe('ok')
    expect(q.coerceToString(Buffer.from('ok', 'utf8'), 'prompt')).toBe('ok')
    expect(q.coerceToString('ok', 'prompt')).toBe('ok')
    expect(() => q.coerceToString(42, 'prompt')).toThrow(/must be a string/)
  })
})
