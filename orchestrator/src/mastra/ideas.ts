import { createClient, type Client } from '@libsql/client'
import { randomBytes } from 'node:crypto'
import { resolveContext } from './context'
import type { Author, AuthorKind } from './author'

export type IdeaSource = 'reflection' | 'human' | 'planner'

export interface Idea {
  id: string
  goal: string
  story: string
  technical: string
  status: string
  source: IdeaSource
  author: Author | null
  createdAt: number
  updatedAt: number
  acceptance: string[]
  promotedTaskId: string | null
}

let clientSingleton: Client | null = null

const getClient = (): Client => {
  if (clientSingleton) return clientSingleton
  const { stateDbPath } = resolveContext()
  clientSingleton = createClient({ url: `file:${stateDbPath}` })
  return clientSingleton
}

let initialised = false

export const initIdeas = async (): Promise<void> => {
  if (initialised) return
  const c = getClient()
  await c.execute(`
    CREATE TABLE IF NOT EXISTS ideas (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      story TEXT NOT NULL DEFAULT '',
      technical TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      source TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  await c.execute(`
    CREATE TABLE IF NOT EXISTS idea_acceptance (
      idea_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY(idea_id, position),
      FOREIGN KEY(idea_id) REFERENCES ideas(id) ON DELETE CASCADE
    )
  `)
  const cols = await c.execute(`PRAGMA table_info(ideas)`)
  const colNames = new Set(
    cols.rows.map((r) => (r as unknown as { name: string }).name),
  )
  if (!colNames.has('author_kind')) {
    await c.execute(`ALTER TABLE ideas ADD COLUMN author_kind TEXT`)
  }
  if (!colNames.has('author_name')) {
    await c.execute(`ALTER TABLE ideas ADD COLUMN author_name TEXT`)
  }
  if (!colNames.has('promoted_task_id')) {
    await c.execute(`ALTER TABLE ideas ADD COLUMN promoted_task_id TEXT`)
  }
  // Migrate legacy `origin` column (values 'user' | 'agent') into `source`
  // (values 'human' | 'planner' | 'reflection'). The legacy column is
  // dropped after the values are copied across.
  if (colNames.has('origin') && !colNames.has('source')) {
    await c.execute(
      `ALTER TABLE ideas ADD COLUMN source TEXT NOT NULL DEFAULT 'human'`,
    )
    await c.execute(
      `UPDATE ideas
          SET source = CASE
            WHEN author_kind = 'agent' THEN 'planner'
            WHEN origin = 'agent'      THEN 'planner'
            ELSE 'human'
          END`,
    )
    await c.execute(`ALTER TABLE ideas DROP COLUMN origin`)
  } else if (!colNames.has('source')) {
    await c.execute(
      `ALTER TABLE ideas ADD COLUMN source TEXT NOT NULL DEFAULT 'human'`,
    )
  }
  await migrateLegacyFeatures(c)
  // Run after `initQueue` has had a chance to migrate `tasks.blocker_id`
  // out into `task_blockers` rows, since that migration reads
  // `task_suggestions` and we are about to drop it.
  const { initQueue } = await import('./queue')
  await initQueue()
  await migrateTaskSuggestions(c)
  initialised = true
}

const migrateLegacyFeatures = async (c: Client): Promise<void> => {
  const tableCheck = await c.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='features'`,
    args: [],
  })
  if (tableCheck.rows.length === 0) return

  const legacy = await c.execute(`SELECT * FROM features`)

  const tx = await c.transaction('write')
  try {
    for (const row of legacy.rows) {
      const r = row as unknown as Record<string, unknown>
      const id = r.id as string
      const goal = (r.goal as string | null) ?? ''
      const status = (r.status as string | null) ?? 'draft'
      const legacyOrigin = (r.origin as string | null) ?? 'user'
      const source: IdeaSource = legacyOrigin === 'agent' ? 'planner' : 'human'
      const createdMs = Date.parse((r.created_at as string | null) ?? '')
      const updatedMs = Date.parse((r.updated_at as string | null) ?? '')
      const now = Date.now()
      const createdAt = Number.isFinite(createdMs) ? createdMs : now
      const updatedAt = Number.isFinite(updatedMs) ? updatedMs : now

      const result = await tx.execute({
        sql: `INSERT OR IGNORE INTO ideas (id, goal, story, technical, status, source, created_at, updated_at)
              VALUES (?, ?, '', '', ?, ?, ?, ?)`,
        args: [id, goal, status, source, createdAt, updatedAt],
      })
      if (result.rowsAffected === 0) {
        console.warn(
          `[ideas] migrate: skipped legacy features row ${id} — id already present in ideas`,
        )
      }
    }
    await tx.execute(`DROP INDEX IF EXISTS idx_features_status`)
    await tx.execute(`DROP INDEX IF EXISTS idx_features_parent`)
    await tx.execute(`DROP TABLE IF EXISTS feature_deps`)
    await tx.execute(`DROP TABLE features`)
    await tx.commit()
  } catch (error: unknown) {
    tx.close()
    throw error
  }
}

/**
 * One-shot migration: copy any reflection-origin rows out of the legacy
 * `task_suggestions` table (in queue.db) into `ideas` with
 * `source='reflection'`. Runs idempotently — rows whose id already exists
 * in ideas are skipped. The actual DROP of task_suggestions happens during
 * queue init, after this migration has copied the rows out.
 */
const migrateTaskSuggestions = async (c: Client): Promise<void> => {
  const { queueDbPath } = resolveContext()
  let queueClient: Client
  try {
    queueClient = createClient({ url: `file:${queueDbPath}` })
  } catch {
    return
  }
  try {
    const tableCheck = await queueClient.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='task_suggestions'`,
      args: [],
    })
    if (tableCheck.rows.length === 0) return

    const cols = await queueClient.execute(`PRAGMA table_info(task_suggestions)`)
    const colNames = new Set(
      cols.rows.map((r) => (r as unknown as { name: string }).name),
    )
    const hasKind = colNames.has('kind')
    const sql = hasKind
      ? `SELECT id, title, prompt, rationale, status, kind, created_task_id, created_at
           FROM task_suggestions
          WHERE kind = 'reflection' OR kind IS NULL`
      : `SELECT id, title, prompt, rationale, status, created_task_id, created_at,
                NULL AS kind FROM task_suggestions`
    const rows = await queueClient.execute(sql)

    const tx = await c.transaction('write')
    try {
      for (const row of rows.rows) {
        const r = row as unknown as {
          id: string
          title: string | null
          prompt: string | null
          rationale: string | null
          status: string | null
          kind: string | null
          created_task_id: string | null
          created_at: string | null
        }
        const goal = (r.title ?? '').trim() || '(reflection)'
        const story = (r.prompt ?? '').trim()
        const technical = (r.rationale ?? '').trim()
        const status =
          r.status === 'promoted' || r.status === 'accepted'
            ? 'promoted'
            : r.status === 'rejected'
              ? 'dismissed'
              : 'draft'
        const createdMs = Date.parse(r.created_at ?? '')
        const now = Date.now()
        const createdAt = Number.isFinite(createdMs) ? createdMs : now
        await tx.execute({
          sql: `INSERT OR IGNORE INTO ideas
                  (id, goal, story, technical, status, source,
                   author_kind, author_name, promoted_task_id,
                   created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'reflection',
                        'agent', 'reflector', ?,
                        ?, ?)`,
          args: [
            r.id,
            goal,
            story,
            technical,
            status,
            r.created_task_id ?? null,
            createdAt,
            createdAt,
          ],
        })
      }
      await tx.commit()
    } catch (error: unknown) {
      tx.close()
      throw error
    }
    // After copying reflection rows out, drop the legacy table from queue.db.
    // Any remaining rows (kind='fix') are vestigial — fix tasks are now
    // first-class entries in `tasks` linked via `task_blockers`.
    await queueClient.execute(
      `DROP INDEX IF EXISTS idx_task_suggestions_source_task_id`,
    )
    await queueClient.execute(
      `DROP INDEX IF EXISTS idx_task_suggestions_failure_signature`,
    )
    await queueClient.execute(`DROP TABLE IF EXISTS task_suggestions`)
  } finally {
    queueClient.close()
  }
}

const slugify = (goal: string): string => {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug || 'idea'
}

export const generateIdeaId = (goal: string): string => {
  const prefix = randomBytes(4).toString('hex')
  return `${prefix}-${slugify(goal)}`
}

const normaliseSource = (raw: unknown): IdeaSource => {
  if (raw === 'reflection' || raw === 'planner' || raw === 'human') return raw
  return 'human'
}

const rowToIdea = (
  row: Record<string, unknown>,
  acceptance: string[],
): Idea => {
  const authorKindRaw = (row.author_kind as string | null) ?? null
  const authorName = (row.author_name as string | null) ?? null
  const author: Author | null =
    authorKindRaw === 'human' || authorKindRaw === 'agent'
      ? { kind: authorKindRaw as AuthorKind, name: authorName ?? 'unknown' }
      : null
  return {
    id: row.id as string,
    goal: (row.goal as string | null) ?? '',
    story: (row.story as string | null) ?? '',
    technical: (row.technical as string | null) ?? '',
    status: (row.status as string | null) ?? 'draft',
    source: normaliseSource(row.source),
    author,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    acceptance,
    promotedTaskId: (row.promoted_task_id as string | null) ?? null,
  }
}

const loadAcceptance = async (
  c: Client,
  ideaId: string,
): Promise<string[]> => {
  const r = await c.execute({
    sql: `SELECT text FROM idea_acceptance WHERE idea_id = ? ORDER BY position ASC`,
    args: [ideaId],
  })
  return r.rows.map((row) => (row as unknown as { text: string }).text)
}

export interface CreateIdeaOptions {
  author?: Author
  source?: IdeaSource
  story?: string
  technical?: string
}

export const createIdea = async (
  goal: string,
  opts?: CreateIdeaOptions,
): Promise<Idea> => {
  await initIdeas()
  const c = getClient()
  const id = generateIdeaId(goal)
  const now = Date.now()
  const source: IdeaSource =
    opts?.source ??
    (opts?.author?.kind === 'agent' ? 'planner' : 'human')
  const authorKind = opts?.author?.kind ?? null
  const authorName = opts?.author?.name ?? null
  const story = opts?.story ?? ''
  const technical = opts?.technical ?? ''
  await c.execute({
    sql: `INSERT INTO ideas (id, goal, story, technical, status, source, author_kind, author_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    args: [id, goal, story, technical, source, authorKind, authorName, now, now],
  })
  return {
    id,
    goal,
    story,
    technical,
    status: 'draft',
    source,
    author: opts?.author ?? null,
    createdAt: now,
    updatedAt: now,
    acceptance: [],
    promotedTaskId: null,
  }
}

export interface ListIdeasFilter {
  source?: IdeaSource
  status?: string
}

export type IdeaIdResolution =
  | { kind: 'unique'; id: string }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' }

const MIN_PREFIX_LENGTH = 4

export const resolveIdeaId = async (
  idOrPrefix: string,
): Promise<IdeaIdResolution> => {
  await initIdeas()
  const c = getClient()
  const exact = await c.execute({
    sql: `SELECT id FROM ideas WHERE id = ?`,
    args: [idOrPrefix],
  })
  if (exact.rows.length === 1) {
    return { kind: 'unique', id: (exact.rows[0] as unknown as { id: string }).id }
  }
  if (idOrPrefix.length < MIN_PREFIX_LENGTH) return { kind: 'none' }
  const prefixMatch = await c.execute({
    sql: `SELECT id FROM ideas WHERE id LIKE ? || '%' LIMIT 2`,
    args: [idOrPrefix],
  })
  if (prefixMatch.rows.length === 0) return { kind: 'none' }
  if (prefixMatch.rows.length === 1) {
    return {
      kind: 'unique',
      id: (prefixMatch.rows[0] as unknown as { id: string }).id,
    }
  }
  const total = await c.execute({
    sql: `SELECT COUNT(*) AS n FROM ideas WHERE id LIKE ? || '%'`,
    args: [idOrPrefix],
  })
  const count = Number(
    (total.rows[0] as unknown as { n: number | bigint }).n ?? 2,
  )
  return { kind: 'ambiguous', count }
}

export const getIdea = async (idOrPrefix: string): Promise<Idea | null> => {
  const resolved = await resolveIdeaId(idOrPrefix)
  if (resolved.kind !== 'unique') return null
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT * FROM ideas WHERE id = ?`,
    args: [resolved.id],
  })
  if (r.rows.length === 0) return null
  const acceptance = await loadAcceptance(c, resolved.id)
  return rowToIdea(r.rows[0] as unknown as Record<string, unknown>, acceptance)
}

export const listIdeas = async (filter?: ListIdeasFilter): Promise<Idea[]> => {
  await initIdeas()
  const c = getClient()
  const where: string[] = []
  const args: unknown[] = []
  if (filter?.source) {
    where.push('source = ?')
    args.push(filter.source)
  }
  if (filter?.status) {
    where.push('status = ?')
    args.push(filter.status)
  }
  const sql = `SELECT * FROM ideas${
    where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at DESC`
  const r =
    args.length > 0
      ? await c.execute({ sql, args: args as never })
      : await c.execute(sql)
  const ideas: Idea[] = []
  for (const row of r.rows) {
    const r2 = row as unknown as Record<string, unknown>
    const acceptance = await loadAcceptance(c, r2.id as string)
    ideas.push(rowToIdea(r2, acceptance))
  }
  return ideas
}

export type IdeaField = 'goal' | 'story' | 'technical' | 'status'

const fieldColumn: Record<IdeaField, string> = {
  goal: 'goal',
  story: 'story',
  technical: 'technical',
  status: 'status',
}

export const setIdeaField = async (
  id: string,
  field: IdeaField,
  value: string,
): Promise<Idea> => {
  await initIdeas()
  const c = getClient()
  const existing = await c.execute({
    sql: `SELECT id FROM ideas WHERE id = ?`,
    args: [id],
  })
  if (existing.rows.length === 0) {
    throw new Error(`idea ${id} not found`)
  }
  const now = Date.now()
  await c.execute({
    sql: `UPDATE ideas SET ${fieldColumn[field]} = ?, updated_at = ? WHERE id = ?`,
    args: [value, now, id],
  })
  const updated = await getIdea(id)
  if (!updated) {
    throw new Error(`idea ${id} disappeared after update`)
  }
  return updated
}

export const addIdeaAcceptance = async (
  id: string,
  bullet: string,
): Promise<Idea> => {
  await initIdeas()
  const c = getClient()
  const existing = await c.execute({
    sql: `SELECT id FROM ideas WHERE id = ?`,
    args: [id],
  })
  if (existing.rows.length === 0) {
    throw new Error(`idea ${id} not found`)
  }
  const positionRow = await c.execute({
    sql: `SELECT COALESCE(MAX(position), -1) AS max_pos FROM idea_acceptance WHERE idea_id = ?`,
    args: [id],
  })
  const maxPos = Number(
    (positionRow.rows[0] as unknown as { max_pos: number | string }).max_pos ??
      -1,
  )
  const next = Number.isFinite(maxPos) ? maxPos + 1 : 0
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO idea_acceptance (idea_id, position, text) VALUES (?, ?, ?)`,
    args: [id, next, bullet],
  })
  await c.execute({
    sql: `UPDATE ideas SET updated_at = ? WHERE id = ?`,
    args: [now, id],
  })
  const updated = await getIdea(id)
  if (!updated) {
    throw new Error(`idea ${id} disappeared after update`)
  }
  return updated
}

export const removeIdeaAcceptance = async (
  id: string,
  index: number,
): Promise<Idea> => {
  await initIdeas()
  const c = getClient()
  const existing = await c.execute({
    sql: `SELECT id FROM ideas WHERE id = ?`,
    args: [id],
  })
  if (existing.rows.length === 0) {
    throw new Error(`idea ${id} not found`)
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`acceptance index must be a non-negative integer`)
  }
  const tx = await c.transaction('write')
  try {
    const target = await tx.execute({
      sql: `SELECT position FROM idea_acceptance WHERE idea_id = ? AND position = ?`,
      args: [id, index],
    })
    if (target.rows.length === 0) {
      tx.close()
      throw new Error(
        `idea ${id} has no acceptance bullet at index ${index}`,
      )
    }
    await tx.execute({
      sql: `DELETE FROM idea_acceptance WHERE idea_id = ? AND position = ?`,
      args: [id, index],
    })
    await tx.execute({
      sql: `UPDATE idea_acceptance
            SET position = position - 1
            WHERE idea_id = ? AND position > ?`,
      args: [id, index],
    })
    const now = Date.now()
    await tx.execute({
      sql: `UPDATE ideas SET updated_at = ? WHERE id = ?`,
      args: [now, id],
    })
    await tx.commit()
  } catch (error: unknown) {
    tx.close()
    throw error
  }
  const updated = await getIdea(id)
  if (!updated) {
    throw new Error(`idea ${id} disappeared after update`)
  }
  return updated
}

export interface PromoteIdeaResult {
  idea: Idea
  prompt: string
}

const composePromoteIdeaPrompt = (idea: Idea): string => {
  const sections: string[] = []
  sections.push(`# Goal\n${idea.goal.trim()}`)
  if (idea.story.trim().length > 0) {
    sections.push(`# Story\n${idea.story.trim()}`)
  }
  if (idea.acceptance.length > 0) {
    const bullets = idea.acceptance.map((b) => `- ${b}`).join('\n')
    sections.push(`# Acceptance\n${bullets}`)
  }
  if (idea.technical.trim().length > 0) {
    sections.push(`# Technical notes\n${idea.technical.trim()}`)
  }
  return sections.join('\n\n')
}

export const validateIdeaShaped = (idea: Idea): string[] => {
  const missing: string[] = []
  if (idea.story.trim().length === 0) missing.push('story')
  if (idea.technical.trim().length === 0) missing.push('technical')
  if (idea.acceptance.length === 0) missing.push('acceptance (>=1 bullet)')
  return missing
}

export const promoteIdea = async (
  idOrPrefix: string,
): Promise<PromoteIdeaResult> => {
  await initIdeas()
  const resolved = await resolveIdeaId(idOrPrefix)
  if (resolved.kind === 'ambiguous') {
    throw new Error(
      `ambiguous prefix '${idOrPrefix}' matches ${resolved.count} ideas`,
    )
  }
  if (resolved.kind === 'none') {
    throw new Error(`idea ${idOrPrefix} not found`)
  }
  const idea = await getIdea(resolved.id)
  if (!idea) {
    throw new Error(`idea ${resolved.id} not found`)
  }
  if (idea.status !== 'draft') {
    throw new Error(
      `idea ${idea.id} is '${idea.status}'; only draft ideas can be promoted`,
    )
  }
  const missing = validateIdeaShaped(idea)
  if (missing.length > 0) {
    throw new Error(
      `idea ${idea.id} is not fully shaped; missing: ${missing.join(', ')}`,
    )
  }
  const prompt = composePromoteIdeaPrompt(idea)
  return { idea, prompt }
}

export const markIdeaPromoted = async (
  ideaId: string,
  taskId: string,
): Promise<Idea> => {
  await initIdeas()
  const c = getClient()
  const now = Date.now()
  const r = await c.execute({
    sql: `UPDATE ideas SET status = 'promoted', promoted_task_id = ?, updated_at = ? WHERE id = ?`,
    args: [taskId, now, ideaId],
  })
  if (r.rowsAffected === 0) {
    throw new Error(`idea ${ideaId} not found`)
  }
  const updated = await getIdea(ideaId)
  if (!updated) {
    throw new Error(`idea ${ideaId} disappeared after promotion`)
  }
  return updated
}

