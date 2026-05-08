import { createClient, type Client } from '@libsql/client'
import { randomBytes } from 'node:crypto'
import { resolveContext } from './context'

export type IdeaStatus = 'draft' | 'queued' | 'planning' | 'done' | 'failed'
export type IdeaField = 'goal' | 'story' | 'technical' | 'status'

export interface Idea {
  id: string
  goal: string
  story: string
  technical: string
  status: string
  origin: string
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
  initialised = true
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
): Idea => ({
  id: row.id as string,
  goal: (row.goal as string | null) ?? '',
  story: (row.story as string | null) ?? '',
  technical: (row.technical as string | null) ?? '',
  status: (row.status as string | null) ?? 'draft',
  origin: (row.origin as string | null) ?? 'user',
  createdAt: Number(row.created_at ?? 0),
  updatedAt: Number(row.updated_at ?? 0),
  acceptance,
})

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

export const createIdea = async (goal: string): Promise<Idea> => {
  await initIdeas()
  const c = getClient()
  const id = generateIdeaId(goal)
  const now = Date.now()
  await c.execute({
    sql: `INSERT INTO ideas (id, goal, story, technical, status, origin, created_at, updated_at)
          VALUES (?, ?, '', '', 'draft', 'user', ?, ?)`,
    args: [id, goal, now, now],
  })
  return {
    id,
    goal,
    story: '',
    technical: '',
    status: 'draft',
    origin: 'user',
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
