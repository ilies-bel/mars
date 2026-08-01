import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openDb } from '../lib/db.js'

/**
 * Retention window for archived (evaporated) chat threads.
 *
 * Threads are evaporated when their purpose is fulfilled but are retained in
 * the History accordion for a human to review. Past this window they are
 * permanently deleted along with their messages and upload directories.
 *
 * The sole permanent artifact of a chat session is the release-note / hero
 * summary written at arc completion — chat threads themselves are ephemeral.
 *
 * Override via MARS_CHAT_RETENTION_DAYS.
 */
export const CHAT_ARCHIVE_RETENTION_DAYS =
  Number(process.env.MARS_CHAT_RETENTION_DAYS ?? 30)

export interface ChatArchiveSweepResult {
  /** Number of chat_threads rows permanently deleted. */
  deletedThreads: number
  /** Number of .mars/chat-uploads/<id>/ directories removed. */
  deletedUploadDirs: number
}

/**
 * Permanently delete evaporated chat threads and their associated data that
 * are older than `retentionDays` (default: {@link CHAT_ARCHIVE_RETENTION_DAYS}).
 *
 * Deletion order:
 *   1. chat_messages WHERE thread_id IN (expired threads)  — cascade cleans chat_feedback
 *   2. chat_threads  WHERE evaporated_at < cutoff
 *   3. .mars/chat-uploads/<threadId>/  — upload files for those threads
 *
 * Active (non-evaporated) threads are never touched. Recently evaporated
 * threads (within the retention window) remain in the History accordion.
 */
export const sweepChatArchive = async (
  dbTarget: string,
  uploadsRoot: string,
  retentionDays = CHAT_ARCHIVE_RETENTION_DAYS,
): Promise<ChatArchiveSweepResult> => {
  const client = openDb(dbTarget)
  try {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

    // Collect IDs first so we can remove their upload directories after deletion.
    const found = await client.execute({
      sql: `SELECT id FROM chat_threads WHERE evaporated_at IS NOT NULL AND evaporated_at < ?`,
      args: [cutoff],
    })
    const threadIds = (found.rows as unknown as Array<{ id: string }>).map((r) => r.id)

    if (threadIds.length === 0) {
      return { deletedThreads: 0, deletedUploadDirs: 0 }
    }

    // Delete messages (ON DELETE CASCADE on chat_feedback.message_id cleans feedback rows).
    // Use a subquery so a single statement sweeps all expired threads.
    await client.execute({
      sql: `DELETE FROM chat_messages WHERE thread_id IN (
              SELECT id FROM chat_threads WHERE evaporated_at IS NOT NULL AND evaporated_at < ?
            )`,
      args: [cutoff],
    })

    // Delete the threads themselves.
    const deleteResult = await client.execute({
      sql: `DELETE FROM chat_threads WHERE evaporated_at IS NOT NULL AND evaporated_at < ?`,
      args: [cutoff],
    })

    // Remove upload directories for the deleted threads.
    let deletedUploadDirs = 0
    for (const id of threadIds) {
      const dir = join(uploadsRoot, id)
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true })
        deletedUploadDirs += 1
      }
    }

    return {
      deletedThreads: deleteResult.rowsAffected,
      deletedUploadDirs,
    }
  } finally {
    await client.close()
  }
}
