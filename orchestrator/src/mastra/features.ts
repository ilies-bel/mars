import { createClient, type Client } from '@libsql/client'
import { existsSync } from 'node:fs'
import { resolveContext } from './context'

export type FeatureStatus = 'draft' | 'queued' | 'planning' | 'done' | 'failed'

export interface Feature {
  id: string
  goal: string
  status: FeatureStatus
  origin: string
  taskCount: number
  readyTaskCount: number
  parentId: string | null
  createdAt: string
  updatedAt: string
  storeId: string | null
}

let clientSingleton: Client | null = null

const getClient = (): Client | null => {
  if (clientSingleton) return clientSingleton
  const { stateDbPath } = resolveContext()
  if (!existsSync(stateDbPath)) return null
  clientSingleton = createClient({ url: `file:${stateDbPath}` })
  return clientSingleton
}

const featuresTableExists = async (c: Client): Promise<boolean> => {
  const r = await c.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'features'`,
    args: [],
  })
  return r.rows.length > 0
}

const rowToFeature = (row: Record<string, unknown>): Feature => ({
  id: row.id as string,
  goal: (row.goal as string | null) ?? '',
  status: row.status as FeatureStatus,
  origin: (row.origin as string | null) ?? '',
  taskCount: Number((row.task_count as number | null) ?? 0),
  readyTaskCount: Number((row.ready_task_count as number | null) ?? 0),
  parentId: (row.parent_id as string | null) ?? null,
  createdAt: row.created_at as string,
  updatedAt: row.updated_at as string,
  storeId: (row.store_id as string | null) ?? null,
})

export const listFeatures = async (
  status?: FeatureStatus,
): Promise<Feature[]> => {
  const c = getClient()
  if (!c) return []
  if (!(await featuresTableExists(c))) return []
  const r = status
    ? await c.execute({
        sql: `SELECT * FROM features WHERE status = ? ORDER BY created_at DESC`,
        args: [status],
      })
    : await c.execute(`SELECT * FROM features ORDER BY created_at DESC`)
  return r.rows.map((row) => rowToFeature(row as unknown as Record<string, unknown>))
}

export const getFeature = async (id: string): Promise<Feature | null> => {
  const c = getClient()
  if (!c) return null
  if (!(await featuresTableExists(c))) return null
  const r = await c.execute({
    sql: `SELECT * FROM features WHERE id = ?`,
    args: [id],
  })
  if (r.rows.length === 0) return null
  return rowToFeature(r.rows[0] as unknown as Record<string, unknown>)
}
