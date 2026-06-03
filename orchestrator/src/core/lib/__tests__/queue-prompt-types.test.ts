import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createClient } from '@libsql/client'

interface Queue {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  listTasks: typeof import('../../queue').listTasks
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
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

  it('migrateQueueSchema heals pre-existing blob prompts to TEXT (idempotent)', async () => {
    const q = await loadQueue(repo)
    await q.enqueueTask('seed', undefined, { skipTriage: true })

    const dbPath = resolve(repo, '.mars/mars.db')
    const direct = createClient({ url: `file:${dbPath}` })
    const now = new Date().toISOString()
    await direct.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: ['blobby01', new Uint8Array([0x68, 0x69]), 'queued', now, now],
    })
    const before = await direct.execute(
      `SELECT typeof(prompt) AS t FROM tasks WHERE id = 'blobby01'`,
    )
    expect((before.rows[0] as unknown as { t: string }).t).toBe('blob')

    await q.migrateQueueSchema()

    const after = await direct.execute(
      `SELECT typeof(prompt) AS t, prompt AS p FROM tasks WHERE id = 'blobby01'`,
    )
    expect((after.rows[0] as unknown as { t: string }).t).toBe('text')
    expect((after.rows[0] as unknown as { p: string }).p).toBe('hi')

    // Idempotent: a second pass leaves text alone and reports 0 blobs.
    await q.migrateQueueSchema()
    const again = await direct.execute(
      `SELECT typeof(prompt) AS t FROM tasks WHERE id = 'blobby01'`,
    )
    expect((again.rows[0] as unknown as { t: string }).t).toBe('text')
  })

  it('migrateQueueSchema does not create task_transcripts (migrated to trace_events in PRD 436f14c7)', async () => {
    // task_transcripts is no longer created on fresh databases; data from
    // pre-migration databases is lifted into trace_events and the table is dropped.
    const q = await loadQueue(repo)
    await q.migrateQueueSchema()
    const dbPath = resolve(repo, '.mars/mars.db')
    const direct = createClient({ url: `file:${dbPath}` })
    const tables = await direct.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_transcripts'`,
    )
    expect(tables.rows.length).toBe(0)

    // trace_events must exist (migration ensures it).
    const traceTable = await direct.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trace_events'`,
    )
    expect(traceTable.rows.length).toBe(1)
    direct.close()
  })

  it('reading a row whose prompt was forced to a Uint8Array decodes via rowToTask', async () => {
    const q = await loadQueue(repo)
    const dbPath = resolve(repo, '.mars/mars.db')
    const direct = createClient({ url: `file:${dbPath}` })
    const now = new Date().toISOString()
    // Write a row with a non-string prompt, but skip the boot-time heal by
    // inserting AFTER migrateQueueSchema completes. getTask must still return a string.
    await direct.execute({
      sql: `INSERT INTO tasks (id, prompt, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: ['raw00001', new Uint8Array([0x6f, 0x6b]), 'queued', now, now],
    })
    const t = await q.getTask('raw00001')
    expect(typeof t?.prompt).toBe('string')
    expect(t?.prompt).toBe('ok')
  })
})
