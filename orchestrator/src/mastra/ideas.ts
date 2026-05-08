import { createClient, type Client } from '@libsql/client'
import { randomBytes } from 'node:crypto'
import { resolveContext } from './context'
import type { Author, AuthorKind } from './author'

export type IdeaStatus = 'draft' | 'queued' | 'planning' | 'done' | 'failed'
export type IdeaField = 'goal' | 'story' | 'technical' | 'status'

export interface Idea {
  id: string
  goal: string
  story: string
  technical: string
  status: string
  origin: string
  author: Author | null
  createdAt: number
  updatedAt: number
  acceptance: string[]
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
      origin TEXT NOT NULL DEFAULT 'user',
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
  await migrateLegacyFeatures(c)
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
      const origin = (r.origin as string | null) ?? 'user'
      const createdMs = Date.parse((r.created_at as string | null) ?? '')
      const updatedMs = Date.parse((r.updated_at as string | null) ?? '')
      const now = Date.now()
      const createdAt = Number.isFinite(createdMs) ? createdMs : now
      const updatedAt = Number.isFinite(updatedMs) ? updatedMs : now

      const result = await tx.execute({
        sql: `INSERT OR IGNORE INTO ideas (id, goal, story, technical, status, origin, created_at, updated_at)
              VALUES (?, ?, '', '', ?, ?, ?, ?)`,
        args: [id, goal, status, origin, createdAt, updatedAt],
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
    origin: (row.origin as string | null) ?? 'user',
    author,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    acceptance,
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
}

export const createIdea = async (
  goal: string,
  opts?: CreateIdeaOptions,
): Promise<Idea> => {
  await initIdeas()
  const c = getClient()
  const id = generateIdeaId(goal)
  const now = Date.now()
  const origin = opts?.author?.kind === 'agent' ? 'agent' : 'user'
  const authorKind = opts?.author?.kind ?? null
  const authorName = opts?.author?.name ?? null
  await c.execute({
    sql: `INSERT INTO ideas (id, goal, story, technical, status, origin, author_kind, author_name, created_at, updated_at)
          VALUES (?, ?, '', '', 'draft', ?, ?, ?, ?, ?)`,
    args: [id, goal, origin, authorKind, authorName, now, now],
  })
  return {
    id,
    goal,
    story: '',
    technical: '',
    status: 'draft',
    origin,
    author: opts?.author ?? null,
    createdAt: now,
    updatedAt: now,
    acceptance: [],
  }
}

export const getIdea = async (id: string): Promise<Idea | null> => {
  await initIdeas()
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT * FROM ideas WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  const acceptance = await loadAcceptance(c, id)
  return rowToIdea(r.rows[0] as unknown as Record<string, unknown>, acceptance)
}

export const listIdeas = async (): Promise<Idea[]> => {
  await initIdeas()
  const c = getClient()
  const r = await c.execute(`SELECT * FROM ideas ORDER BY created_at DESC`)
  const ideas: Idea[] = []
  for (const row of r.rows) {
    const r2 = row as unknown as Record<string, unknown>
    const acceptance = await loadAcceptance(c, r2.id as string)
    ideas.push(rowToIdea(r2, acceptance))
  }
  return ideas
}

export const setIdeaField = async (
  id: string,
  field: IdeaField,
  value: string,
): Promise<boolean> => {
  await initIdeas()
  const c = getClient()
  const now = Date.now()
  const column =
    field === 'goal'
      ? 'goal'
      : field === 'story'
        ? 'story'
        : field === 'technical'
          ? 'technical'
          : 'status'
  const r = await c.execute({
    sql: `UPDATE ideas SET ${column} = ?, updated_at = ? WHERE id = ?`,
    args: [value, now, id],
  })
  return r.rowsAffected > 0
}

export const addAcceptance = async (
  id: string,
  text: string,
): Promise<boolean> => {
  await initIdeas()
  const c = getClient()
  const exists = await c.execute({
    sql: `SELECT 1 FROM ideas WHERE id = ?`,
    args: [id],
  })
  if (exists.rows.length === 0) return false
  const r = await c.execute({
    sql: `SELECT COALESCE(MAX(position) + 1, 0) AS next FROM idea_acceptance WHERE idea_id = ?`,
    args: [id],
  })
  const next = Number(
    (r.rows[0] as unknown as { next: number | null }).next ?? 0,
  )
  await c.execute({
    sql: `INSERT INTO idea_acceptance (idea_id, position, text) VALUES (?, ?, ?)`,
    args: [id, next, text],
  })
  await c.execute({
    sql: `UPDATE ideas SET updated_at = ? WHERE id = ?`,
    args: [Date.now(), id],
  })
  return true
}

export const removeAcceptance = async (
  id: string,
  index: number,
): Promise<boolean> => {
  await initIdeas()
  const c = getClient()
  const r = await c.execute({
    sql: `SELECT text FROM idea_acceptance WHERE idea_id = ? ORDER BY position ASC`,
    args: [id],
  })
  if (index < 0 || index >= r.rows.length) return false
  const remaining = r.rows
    .map((row) => (row as unknown as { text: string }).text)
    .filter((_, i) => i !== index)
  await c.execute({
    sql: `DELETE FROM idea_acceptance WHERE idea_id = ?`,
    args: [id],
  })
  for (let i = 0; i < remaining.length; i += 1) {
    await c.execute({
      sql: `INSERT INTO idea_acceptance (idea_id, position, text) VALUES (?, ?, ?)`,
      args: [id, i, remaining[i]],
    })
  }
  await c.execute({
    sql: `UPDATE ideas SET updated_at = ? WHERE id = ?`,
    args: [Date.now(), id],
  })
  return true
}

export const deleteIdea = async (id: string): Promise<boolean> => {
  await initIdeas()
  const c = getClient()
  const r = await c.execute({
    sql: `DELETE FROM ideas WHERE id = ?`,
    args: [id],
  })
  await c.execute({
    sql: `DELETE FROM idea_acceptance WHERE idea_id = ?`,
    args: [id],
  })
  return r.rowsAffected > 0
}

export const renderIdeaMarkdown = (idea: Idea): string => {
  const lines: string[] = []
  lines.push('---')
  lines.push(`id: ${idea.id}`)
  lines.push(`status: ${idea.status}`)
  lines.push(`origin: ${idea.origin}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${idea.goal}`)
  lines.push('')
  lines.push('## Story')
  lines.push('')
  if (idea.story.trim().length > 0) {
    lines.push(idea.story.trim())
    lines.push('')
  }
  if (idea.acceptance.length > 0) {
    lines.push('**Acceptance**')
    lines.push('')
    for (const bullet of idea.acceptance) {
      lines.push(`- ${bullet}`)
    }
    lines.push('')
  }
  lines.push('## Technical')
  lines.push('')
  if (idea.technical.trim().length > 0) {
    lines.push(idea.technical.trim())
    lines.push('')
  }
  return lines.join('\n')
}
