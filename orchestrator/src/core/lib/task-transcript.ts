/**
 * Transcript persistence helpers extracted from `core/queue.ts` (ADR-0101 item 1).
 *
 * Lives in `core/lib/` so that `core/arc.ts` can import `upsertTranscript`
 * without re-opening the `arc → queue → arc` cycle.  `core/queue.ts`
 * re-exports every symbol for call sites that already depend on the queue
 * surface.
 *
 * MUST NOT import from `core/arc.ts`, `core/queue.ts`, or
 * `core/queue-retry.ts` — doing so recreates the cycle this module was
 * created to break.
 */

import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { type DbStatement } from './db.js'
import { ensureQueueSchema, resolveQueueClient } from './queue-client.js'
import { emitEvent, withWriteTx } from './outbox.js'
import type { DomainTaskStore } from '../store/task-store.js'

const gzipAsyncT = promisify(gzip)

const MAX_CONVERSATION_BYTES = 2 * 1024 * 1024
const HALF_WINDOW_BYTES = 1 * 1024 * 1024

export const capConversationJson = (json: string): string => {
  if (json.length <= MAX_CONVERSATION_BYTES) return json
  const head = json.slice(0, HALF_WINDOW_BYTES)
  const tail = json.slice(json.length - HALF_WINDOW_BYTES)
  const skipped = json.length - head.length - tail.length
  const marker = JSON.stringify({ truncated: true, skippedBytes: skipped })
  return `${head}\n${marker}\n${tail}`
}

export interface UpsertTranscriptInput {
  taskId: string
  conversationJson?: string
  verifyOutput?: string | null
}

export const upsertTranscript = async (
  input: UpsertTranscriptInput,
  store?: DomainTaskStore,
): Promise<void> => {
  const now = Date.now()

  // Write transcript as a gzip-compressed bytea to the dedicated table.
  // This keeps step_ended payloads small so hot aggregate queries are fast.
  let conversationStmt: DbStatement | null = null
  if (input.conversationJson !== undefined) {
    const capped = capConversationJson(input.conversationJson)
    const compressed = await gzipAsyncT(Buffer.from(capped, 'utf8'))
    conversationStmt = {
      sql: `INSERT INTO task_durable_transcripts
              (task_id, session_id, step_name, created_at, transcript, byte_len)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (task_id) DO UPDATE SET
              session_id = excluded.session_id,
              step_name  = excluded.step_name,
              created_at = excluded.created_at,
              transcript = excluded.transcript,
              byte_len   = excluded.byte_len`,
      args: [input.taskId, '', 'code', now, compressed, capped.length],
    }
  }

  // Write verifyOutput to a step_ended event (it is small — at most 64 KB).
  // The transcript field is never written to step_ended any more.
  const verifyEventPayload =
    input.verifyOutput !== undefined && input.verifyOutput !== null
      ? {
          stepName: 'code',
          workflowInstanceId: `upsert-${input.taskId}`,
          outcome: 'success' as const,
          durationMs: 0,
          verifyOutput:
            input.verifyOutput.length > 64 * 1024
              ? input.verifyOutput.slice(0, 64 * 1024)
              : input.verifyOutput,
        }
      : null

  if (conversationStmt === null && verifyEventPayload === null) return

  // The transcript row and its step_ended event share one write transaction:
  // a failure partway through (e.g. a constraint violation on the transcript
  // write) rolls back both, so no orphan event row can ever describe a
  // transcript write that never landed.
  if (store) {
    await store.atomic(async (scope) => {
      if (conversationStmt) await scope.execute(conversationStmt)
      if (verifyEventPayload) {
        await emitEvent(null, 'step_ended', verifyEventPayload, {
          tx: scope,
          taskId: input.taskId,
          phase: 'code',
        })
      }
    })
    return
  }

  await ensureQueueSchema()
  const client = resolveQueueClient()
  await withWriteTx(client, async (tx) => {
    if (conversationStmt) await tx.execute(conversationStmt)
    if (verifyEventPayload) {
      await emitEvent(client, 'step_ended', verifyEventPayload, {
        tx,
        taskId: input.taskId,
        phase: 'code',
      })
    }
  })
}
