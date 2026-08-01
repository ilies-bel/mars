/**
 * Purge archive helper (slice 3 of PRD aa93d9cb).
 *
 * Writes evidence rows to `purged_tasks_archive` so lifecycle history is
 * preserved after a force-purge wipes the task row. The insert is
 * best-effort: callers wrap it in try/catch so a failed archive insert
 * never blocks the purge itself.
 */

import { resolveQueueClient } from '../queue.js'

export interface PurgeArchiveRow {
  id: string
  originId: string | null
  branch: string
  worktreePath: string | null
  terminalStatus: string
  kind: string
  prompt: string
  intent: string
  integratedCommitsJson: string
  compensationTaskId: string | null
  purgedBy: 'purge' | 'arc-purge' | 'supersede'
  forceFlag: boolean
  supersededBy?: string | null
  supersedeNote?: string | null
}

/**
 * Insert one row into `purged_tasks_archive`. Throws on DB error — callers
 * should wrap in try/catch and log the error rather than propagating it.
 */
export async function insertPurgeArchiveRow(row: PurgeArchiveRow): Promise<void> {
  const client = resolveQueueClient()
  await client.execute({
    sql: `INSERT INTO purged_tasks_archive
            (id, origin_id, branch, worktree_path, terminal_status, kind, prompt, intent,
             integrated_commits_json, compensation_task_id, purged_by, force_flag,
             superseded_by, supersede_note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      row.id,
      row.originId,
      row.branch,
      row.worktreePath,
      row.terminalStatus,
      row.kind,
      row.prompt,
      row.intent,
      row.integratedCommitsJson,
      row.compensationTaskId,
      row.purgedBy,
      row.forceFlag,
      row.supersededBy ?? null,
      row.supersedeNote ?? null,
    ],
  })
}
