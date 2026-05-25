import { existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { type Client, createClient } from '@libsql/client'

import { resolveContext } from '../mastra/context'

/**
 * One-shot, idempotent merge of the historical two-database layout
 * (`.mars/queue.db` + `.mars/state.db`) into the single `.mars/mars.db`
 * file mandated by ADR-0034.
 *
 * Sentinel: runs whenever EITHER legacy file is still present. It does
 * NOT key off `existsSync(mars.db)`, because an empty `mars.db` is
 * routinely materialised the moment any libsql client opens the new path
 * (e.g. a stray CLI call before init) — keying off file presence let that
 * empty file silently strand the legacy data forever. Once both legacy
 * files are gone the sentinel is a no-op, so re-running `mars init` is safe.
 *
 * Strategy (always destination-driven through `mars.db`):
 *   1. Open the `mars.db` client and ATTACH whichever legacy files exist.
 *   2. For every table in each source, create it in `main` if missing and
 *      `INSERT OR IGNORE INTO main.<t> SELECT * FROM <src>.<t>`. Existing
 *      `mars.db` rows win on any id collision, so writes that landed in a
 *      prematurely-materialised `mars.db` survive the fold-in.
 *   3. DETACH, then delete the legacy files.
 *
 * Driving through `mars.db` (rather than renaming queue.db over it) is what
 * makes the "empty mars.db already exists" case recover instead of clobber.
 *
 * Drizzle migrations cannot perform file-level steps, which is why this
 * lives as a programmatic migration invoked before any other DB init.
 */
export const mergeLegacyDatabases = async (): Promise<void> => {
  const { stateDir } = resolveContext()
  const queuePath = resolve(stateDir, 'queue.db')
  const statePath = resolve(stateDir, 'state.db')
  const marsPath = resolve(stateDir, 'mars.db')

  // Sentinel: only run while at least one legacy file is present. The
  // presence (or emptiness) of mars.db is deliberately NOT a gate.
  const sources: Array<{ alias: string; path: string }> = []
  if (existsSync(queuePath)) sources.push({ alias: 'legacy_queue', path: queuePath })
  if (existsSync(statePath)) sources.push({ alias: 'legacy_state', path: statePath })
  if (sources.length === 0) return

  // Drive the merge through the canonical mars.db destination so existing
  // rows there (writes that beat the migration) are preserved rather than
  // overwritten by a file rename.
  const c: Client = createClient({ url: `file:${marsPath}` })
  try {
    for (const src of sources) {
      await c.execute(`ATTACH DATABASE '${src.path}' AS ${src.alias}`)
      try {
        const tables = await c.execute(
          `SELECT name, sql FROM ${src.alias}.sqlite_master
            WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
        )
        for (const row of tables.rows) {
          const r = row as unknown as { name: string; sql: string | null }
          if (!r.sql) continue
          // Create the table in the destination if missing, copying the
          // legacy column shape exactly. SELECT * here is intentional: it
          // mirrors whatever columns the source carried.
          await c.execute(
            `CREATE TABLE IF NOT EXISTS main."${r.name}" AS
               SELECT * FROM ${src.alias}."${r.name}" WHERE 0`,
          )
          await c.execute(
            `INSERT OR IGNORE INTO main."${r.name}"
               SELECT * FROM ${src.alias}."${r.name}"`,
          )
        }
        // Copy indices defined on the source (idempotent — IF NOT EXISTS).
        const indices = await c.execute(
          `SELECT sql FROM ${src.alias}.sqlite_master
            WHERE type='index' AND sql IS NOT NULL`,
        )
        for (const row of indices.rows) {
          const r = row as unknown as { sql: string | null }
          if (!r.sql) continue
          const safe = r.sql.replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS ')
          try {
            await c.execute(safe)
          } catch {
            // best-effort: a duplicate name on the destination side wins.
          }
        }
      } finally {
        await c.execute(`DETACH DATABASE ${src.alias}`)
      }
    }
  } finally {
    c.close()
  }

  // File-level cleanup. Done last so a crash mid-copy leaves the legacy
  // files in place and the sentinel re-triggers on the next run.
  for (const src of sources) unlinkSync(src.path)
}
