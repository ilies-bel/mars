import { existsSync, renameSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@libsql/client'
import { resolveContext } from '../mastra/context'

/**
 * One-shot, idempotent merge of the historical two-database layout
 * (`.mars/queue.db` + `.mars/state.db`) into the single `.mars/mars.db`
 * file mandated by ADR-0034.
 *
 * Sentinel: runs only when the OLD layout is present and the NEW file is
 * absent (queue.db AND state.db exist, mars.db does not). On any other
 * combination it is a no-op, so re-running `mars init` after the merge
 * is safe.
 *
 * Strategy:
 *   1. ATTACH state.db into queue.db.
 *   2. For every table in state.db, `INSERT OR IGNORE INTO main.<t>
 *      SELECT * FROM source.<t>`. CREATE TABLE statements run on demand
 *      from `sqlite_master` so we preserve the legacy schema exactly.
 *   3. DETACH, then rename queue.db -> mars.db and delete state.db.
 *
 * Drizzle migrations cannot perform file-rename steps, which is why this
 * lives as a programmatic migration invoked before any other DB init.
 */
export const mergeLegacyDatabases = async (): Promise<void> => {
  const { stateDir } = resolveContext()
  const queuePath = resolve(stateDir, 'queue.db')
  const statePath = resolve(stateDir, 'state.db')
  const marsPath = resolve(stateDir, 'mars.db')

  // Sentinel: only run when the OLD layout is present and the NEW file is
  // absent. Anything else (fresh repo, partially-migrated repo, already
  // migrated repo) is a no-op.
  if (existsSync(marsPath)) return
  if (!existsSync(queuePath) || !existsSync(statePath)) return

  // Drive the merge through the queue.db client, then rename the resulting
  // file. We talk to queue.db at its on-disk path here rather than via
  // `getClient()` (which would resolve to `mars.db` per the new context).
  const c = createClient({ url: `file:${queuePath}` })
  try {
    await c.execute(`ATTACH DATABASE '${statePath}' AS source`)
    try {
      const tables = await c.execute(
        `SELECT name, sql FROM source.sqlite_master
          WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      for (const row of tables.rows) {
        const r = row as unknown as { name: string; sql: string | null }
        if (!r.sql) continue
        // Create the table in the destination if missing. The recorded
        // `sql` from sqlite_master references the table unqualified, so it
        // lands in `main` (the queue.db file) on creation.
        await c.execute(
          `CREATE TABLE IF NOT EXISTS main."${r.name}" AS
             SELECT * FROM source."${r.name}" WHERE 0`,
        )
        await c.execute(
          `INSERT OR IGNORE INTO main."${r.name}"
             SELECT * FROM source."${r.name}"`,
        )
      }
      // Copy indices defined on state.db (idempotent — IF NOT EXISTS).
      const indices = await c.execute(
        `SELECT sql FROM source.sqlite_master
          WHERE type='index' AND sql IS NOT NULL`,
      )
      for (const row of indices.rows) {
        const r = row as unknown as { sql: string | null }
        if (!r.sql) continue
        const safe = r.sql.replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS ')
        try {
          await c.execute(safe)
        } catch {
          // best-effort: a duplicate name on the queue side wins.
        }
      }
    } finally {
      await c.execute(`DETACH DATABASE source`)
    }
  } finally {
    c.close()
  }

  // File-level rename + cleanup. Done last so a crash mid-copy leaves the
  // legacy files in place and the sentinel re-triggers on the next run.
  renameSync(queuePath, marsPath)
  unlinkSync(statePath)
}
