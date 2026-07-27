/**
 * `purge log` — query the purge archive for evidence of force-purged tasks.
 *
 * The `purge` verb itself lives in `lifecycle.ts` (path: 'purge'). This file
 * registers the `purge log` sub-command that reads from `purged_tasks_archive`.
 */

import type { Command } from '../command'

const purgeLog: Command = {
  path: 'purge log',
  summary: 'show the force-purge archive log',
  usage: 'usage: mars purge log [--limit N] [--origin <id>]',
  run: async (args, deps) => {
    const limitRaw = args.flags['--limit']
    const origin = args.flags['--origin']

    let limit = 20
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        deps.err('--limit must be a positive integer')
        return { code: 1 }
      }
      limit = parsed
    }

    let sql: string
    const params: (string | number)[] = []

    if (origin) {
      sql = `SELECT id, terminal_status, branch, purged_at, compensation_task_id
             FROM purged_tasks_archive
             WHERE origin_id = ?
             ORDER BY purged_at DESC
             LIMIT ?`
      params.push(origin, limit)
    } else {
      sql = `SELECT id, terminal_status, branch, purged_at, compensation_task_id
             FROM purged_tasks_archive
             ORDER BY purged_at DESC
             LIMIT ?`
      params.push(limit)
    }

    const result = await deps.store.execute(sql, params)

    if (result.rows.length === 0) {
      deps.out('no purge archive entries found')
      return { code: 0 }
    }

    deps.out('id\tstatus\tbranch\tpurged_at\tcompensation_task_id')
    for (const row of result.rows) {
      const r = row as Record<string, unknown>
      const compId = r.compensation_task_id != null ? String(r.compensation_task_id) : '-'
      const purgedAt = r.purged_at != null ? String(r.purged_at) : '-'
      deps.out(`${r.id}\t${r.terminal_status}\t${r.branch}\t${purgedAt}\t${compId}`)
    }
    return { code: 0 }
  },
}

export const purgeCommands: readonly Command[] = [purgeLog]
