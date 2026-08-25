/**
 * transcript.ts — dependency-free leaf for transcript persistence (ADR-0101).
 *
 * Extracted from `queue.ts` so `arc.ts` can call `upsertTranscript` without
 * importing the queue facade (which imports `Arc` and closes a cycle).
 * `queue.ts` re-exports every public symbol here for backward compatibility.
 */

import { gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { type DbStatement, type DbResultSet } from './db'
import { ensureQueueSchema, resolveQueueClient } from './queue-client'
import { emitEvent, withWriteTx } from './outbox'

const gzipAsync = promisify(gzip)

// ---------------------------------------------------------------------------
// Store interface (structural, avoids value-importing DomainTaskStore)
// ---------------------------------------------------------------------------

interface TranscriptStore {
  atomic(fn: (scope: { execute(stmt: DbStatement): Promise<DbResultSet> }) => Promise<void>): Promise<void>
}

// ---------------------------------------------------------------------------
// capConversationJson
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// UpsertTranscriptInput
// ---------------------------------------------------------------------------

export interface UpsertTranscriptInput {
  taskId: string
  conversationJson?: string
  verifyOutput?: string | null
}

// ---------------------------------------------------------------------------
// upsertTranscript
// ---------------------------------------------------------------------------

export const upsertTranscript = async (
  input: UpsertTranscriptInput,
  store?: TranscriptStore,
): Promise<void> => {
  const now = Date.now()

  // Write transcript as a gzip-compressed bytea to the dedicated table.
  let conversationStmt: DbStatement | null = null
  if (input.conversationJson !== undefined) {
    const capped = capConversationJson(input.conversationJson)
    const compressed = await gzipAsync(Buffer.from(capped, 'utf8'))
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

  // The transcript row and its step_ended event share one write transaction.
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
