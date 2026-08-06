/**
 * closeAndArchive — the single gesture that closes a Subject and archives it.
 *
 * Accepting a Closure card calls this function, which performs three writes in
 * whatever transaction the caller provides:
 *   1. Stamp `closed_at` on the Subject (lifecycle_status → 'closed').
 *   2. Insert an archive_entry with source_kind='subject'.
 *   3. Insert a context_line in the main thread so the operator sees the
 *      outcome without reopening the Subject.
 *
 * All three writes are in one transaction — pass the tx from a `withTransaction`
 * call to guarantee all-or-nothing atomicity. If the transaction rolls back,
 * none of the three writes persist.
 *
 * The caller is responsible for wrapping this in `withTransaction`; the function
 * itself only uses the `execute` interface so it composes with any transaction
 * the caller already holds.
 */

import { randomUUID } from 'node:crypto'
import type { DbTx } from '../lib/db.js'
import { readClosedSubjectFacts, renderContextLine } from '../lib/context-line.js'
import { archiveEntry } from '../archive/insert.js'
import { MAIN_THREAD_ID } from '../lib/pg-schema.js'

/**
 * Close a Subject and archive it in one atomic step.
 *
 * Performs three writes against `tx`:
 *   1. `UPDATE chat_threads SET closed_at = <now> WHERE id = <subjectId> AND closed_at IS NULL`
 *   2. `INSERT INTO archive_entries` with `source_kind='subject'`
 *   3. `INSERT INTO chat_messages` in the main thread with `kind='context_line'`
 *
 * Idempotent on close: if `closed_at` is already set the UPDATE is a no-op,
 * but the archive_entry and context_line are still written — callers should
 * avoid double-closing subjects.
 *
 * @param subjectId - The `chat_threads.id` of the Subject to close.
 * @param tx        - A transaction-scoped executor; wrap with `withTransaction`
 *                    for all-or-nothing atomicity.
 */
export async function closeAndArchive(subjectId: string, tx: DbTx): Promise<void> {
  const now = Date.now()

  // 1. Read the Subject facts inside the transaction for consistency.
  const facts = await readClosedSubjectFacts(tx, subjectId)

  // 2. Stamp closed_at — lifecycle_status transitions to 'closed'.
  await tx.execute({
    sql: `UPDATE chat_threads
             SET closed_at = ?, updated_at = ?
           WHERE id = ? AND closed_at IS NULL`,
    args: [now, now, subjectId],
  })

  // 3. Insert an archive_entry recording this Subject's closure.
  await archiveEntry(tx, {
    kind: 'closed',
    sourceKind: 'subject',
    sourceId: subjectId,
  })

  // 4. Insert a context_line in the main thread so the outcome is visible
  //    in the operator's feed without reopening the Subject.
  const line = facts !== null
    ? renderContextLine(facts)
    : `Closed subject.`
  await tx.execute({
    sql: `INSERT INTO chat_messages
            (id, thread_id, role, content, segments, created_at, context_scope, kind, backing_entity_id)
          VALUES (?, ?, 'assistant', ?, ?, ?, 'main', 'context_line', ?)`,
    args: [
      randomUUID(),
      MAIN_THREAD_ID,
      line,
      JSON.stringify([{ type: 'text', text: line }]),
      now,
      subjectId,
    ],
  })
}
