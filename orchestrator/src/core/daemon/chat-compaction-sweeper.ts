/**
 * Compact inactive chat transcripts into replay checkpoints.
 *
 * MARS_CHAT_COMPACTION_IDLE_MS defaults to five minutes; only idle threads
 * inactive beyond that window are considered. MARS_CHAT_COMPACTION_MIN_CHARS
 * defaults to 30,000 serialized replay characters, avoiding LLM work for
 * short threads. The daemon controls tick frequency with
 * MARS_CHAT_COMPACTION_SWEEP_MS (default one minute).
 *
 * Compaction is non-destructive: it appends an assistant checkpoint and never
 * changes existing chat_messages rows. A failed model call is logged and leaves
 * the candidate thread untouched.
 */

import { randomUUID } from 'node:crypto'
import { openDb } from '../lib/db.js'
import { PROVIDER_MODELS } from '../workers/providers.js'
import {
  collectStructuredChatRefs,
  type ChatMessage,
  type CompactionSegment,
} from '../lib/chat-store.js'
import { messageToApiInput } from './chat-runner.js'
import {
  loadCodexAuth,
  resolveCodexOAuthConfig,
  streamCodexResponse,
  type ResponseInputItem,
} from './codex-api.js'

/** Idle period before a thread becomes eligible for compaction. */
export const CHAT_COMPACTION_IDLE_MS = Number(process.env.MARS_CHAT_COMPACTION_IDLE_MS ?? 5 * 60_000)

/** Minimum serialized replay size required before a transcript is compacted. */
export const CHAT_COMPACTION_MIN_CHARS = Number(process.env.MARS_CHAT_COMPACTION_MIN_CHARS ?? 30_000)

export interface ChatCompactionSweepResult {
  /** Number of checkpoint messages appended during this sweep. */
  compactedThreads: number
}

/**
 * Summarize newly accumulated inactive chat spans into durable replay
 * checkpoints. The latest checkpoint is included in a later summary so one
 * checkpoint always represents the complete history that replay elides.
 */
export const sweepChatCompaction = async (
  dbTarget: string,
  log: (line: string) => void = () => {},
): Promise<ChatCompactionSweepResult> => {
  const client = openDb(dbTarget)
  try {
    const cutoff = Date.now() - CHAT_COMPACTION_IDLE_MS
    const candidates = await client.execute({
      sql: `SELECT id, title, updated_at
              FROM chat_threads
             WHERE status = 'idle' AND closed_at IS NULL AND updated_at < ?`,
      args: [cutoff],
    })
    let compactedThreads = 0

    for (const candidate of candidates.rows as unknown as Array<Record<string, unknown>>) {
      if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || typeof candidate.updated_at !== 'number') {
        continue
      }

      const stored = await client.execute({
        sql: `SELECT id, thread_id, role, content, segments, created_at, context_scope, kind, backing_entity_id
                FROM chat_messages
               WHERE thread_id = ? AND context_scope = 'subthread'
               ORDER BY created_at ASC, seq ASC`,
        args: [candidate.id],
      })
      const messages: ChatMessage[] = (stored.rows as unknown as Array<Record<string, unknown>>).map((row) => {
        let segments: unknown | null = null
        if (typeof row.segments === 'string') {
          try {
            segments = JSON.parse(row.segments) as unknown
          } catch {
            segments = null
          }
        }
        return {
          id: row.id as string,
          thread_id: row.thread_id as string,
          role: row.role === 'assistant' ? 'assistant' : 'user',
          content: row.content as string,
          segments,
          created_at: row.created_at as number,
          context_scope: 'subthread',
          kind: row.kind === 'validation' ? 'validation' : 'acknowledgment',
          backing_entity_id: typeof row.backing_entity_id === 'string' ? row.backing_entity_id : null,
        }
      })

      let checkpointIndex = -1
      let previousCheckpoint: CompactionSegment | null = null
      for (let i = messages.length - 1; i >= 0; i--) {
        const segments = messages[i]?.segments
        if (!Array.isArray(segments)) continue
        const checkpoint = segments.find((segment): segment is Record<string, unknown> =>
          typeof segment === 'object' && segment !== null && !Array.isArray(segment) && segment.type === 'compaction',
        )
        if (
          checkpoint
          && typeof checkpoint.summary === 'string'
          && typeof checkpoint.coveredThrough === 'string'
          && typeof checkpoint.messageCount === 'number'
          && Array.isArray(checkpoint.taskIds) && checkpoint.taskIds.every((value) => typeof value === 'string')
          && Array.isArray(checkpoint.adrRefs) && checkpoint.adrRefs.every((value) => typeof value === 'string')
          && Array.isArray(checkpoint.glossaryRefs) && checkpoint.glossaryRefs.every((value) => typeof value === 'string')
          && Array.isArray(checkpoint.artifactRefs) && checkpoint.artifactRefs.every((value) => typeof value === 'string')
        ) {
          checkpointIndex = i
          previousCheckpoint = {
            type: 'compaction',
            summary: checkpoint.summary,
            coveredThrough: checkpoint.coveredThrough,
            messageCount: checkpoint.messageCount,
            taskIds: checkpoint.taskIds.filter((value): value is string => typeof value === 'string'),
            adrRefs: checkpoint.adrRefs.filter((value): value is string => typeof value === 'string'),
            glossaryRefs: checkpoint.glossaryRefs.filter((value): value is string => typeof value === 'string'),
            artifactRefs: checkpoint.artifactRefs.filter((value): value is string => typeof value === 'string'),
          }
          break
        }
      }

      const postCheckpointMessages = checkpointIndex >= 0 ? messages.slice(checkpointIndex + 1) : messages
      const serializedChars = postCheckpointMessages.reduce(
        (total, message) => total + JSON.stringify(messageToApiInput(message)).length,
        0,
      )
      if (postCheckpointMessages.length === 0 || serializedChars < CHAT_COMPACTION_MIN_CHARS) continue

      try {
        const summaryParts: string[] = []
        const cfg = resolveCodexOAuthConfig()
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs)
        try {
          const input: ResponseInputItem[] = [
            ...(checkpointIndex >= 0 ? messageToApiInput(messages[checkpointIndex]!) : []),
            ...postCheckpointMessages.flatMap(messageToApiInput),
            {
              type: 'message',
              role: 'user',
              content: [{
                type: 'input_text',
                text: 'Summarize this chat transcript for its next agent turn. Preserve the thread goal, decisions and their reasoning, operator requests still outstanding, and touched file paths. Be concise, accurate prose; do not omit unresolved work.',
              }],
            },
          ]
          await streamCodexResponse({
            auth: await loadCodexAuth(),
            model: PROVIDER_MODELS.codex.fast,
            instructions: `You compact Mars daemon chat history. The thread goal is: ${candidate.title}`,
            input,
            tools: [],
            signal: controller.signal,
            onEvent: (event: unknown): void => {
              if (typeof event !== 'object' || event === null || Array.isArray(event)) return
              const value = event as Record<string, unknown>
              if (value.type !== 'response.output_item.done' || typeof value.item !== 'object' || value.item === null || Array.isArray(value.item)) return
              const item = value.item as Record<string, unknown>
              if (item.type !== 'message' || !Array.isArray(item.content)) return
              for (const content of item.content) {
                if (typeof content !== 'object' || content === null || Array.isArray(content)) continue
                const part = content as Record<string, unknown>
                if (part.type === 'output_text' && typeof part.text === 'string') summaryParts.push(part.text)
              }
            },
          })
        } finally {
          clearTimeout(timeout)
        }

        const summary = summaryParts.join('\n').trim()
        if (summary.length === 0) throw new Error('Codex returned no compaction summary.')

        const newRefs = collectStructuredChatRefs(postCheckpointMessages)
        const checkpoint: CompactionSegment = {
          type: 'compaction',
          summary,
          coveredThrough: postCheckpointMessages.at(-1)!.id,
          messageCount: (previousCheckpoint?.messageCount ?? 0) + postCheckpointMessages.length,
          taskIds: [...new Set([...(previousCheckpoint?.taskIds ?? []), ...newRefs.taskIds])],
          adrRefs: [...new Set([...(previousCheckpoint?.adrRefs ?? []), ...newRefs.adrRefs])],
          glossaryRefs: [...new Set([...(previousCheckpoint?.glossaryRefs ?? []), ...newRefs.glossaryRefs])],
          artifactRefs: [...new Set([...(previousCheckpoint?.artifactRefs ?? []), ...newRefs.artifactRefs])],
        }
        const timestamp = Date.now()
        const checkpointId = randomUUID()
        const results = await client.batch([
          {
            sql: `UPDATE chat_threads SET updated_at = ?
                   WHERE id = ? AND status = 'idle' AND updated_at = ?`,
            args: [timestamp, candidate.id, candidate.updated_at],
          },
          {
            sql: `INSERT INTO chat_messages (id, thread_id, role, content, segments, created_at, kind, backing_entity_id)
                  SELECT ?, ?, 'assistant', ?, ?, ?, 'acknowledgment', NULL
                   WHERE EXISTS (
                     SELECT 1 FROM chat_threads WHERE id = ? AND status = 'idle' AND updated_at = ?
                   )`,
            args: [checkpointId, candidate.id, summary, JSON.stringify([checkpoint]), timestamp, candidate.id, timestamp],
          },
        ], 'write')
        if (results[1]?.rowsAffected === 1) compactedThreads += 1
      } catch (err) {
        log(`[chat-compaction-sweep] thread ${candidate.id} left uncompacted: ${(err as Error).message}`)
      }
    }

    return { compactedThreads }
  } finally {
    await client.close()
  }
}
