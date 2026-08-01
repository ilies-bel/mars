/**
 * Compact inactive chat transcripts into replay checkpoints.
 *
 * MARS_CHAT_COMPACTION_IDLE_MS defaults to five minutes; only idle threads
 * inactive beyond that window are considered. MARS_CHAT_COMPACTION_MIN_TOKENS
 * defaults to 8,000 replay tokens, avoiding LLM work for short threads. The
 * daemon controls tick frequency with MARS_CHAT_COMPACTION_SWEEP_MS (default
 * one minute).
 *
 * The gate is measured in TOKENS, not characters. Tokens are the unit the
 * context window is actually denominated in, so a character threshold answers
 * a question nobody is asking — 30,000 characters of dense JSON tool output and
 * 30,000 characters of English prose are not the same amount of context. Where
 * the provider has told us what a turn really cost, that measurement is used;
 * only unmeasured messages fall back to the repo-wide length/4 estimate (the
 * same one chat-memory-window.ts uses).
 *
 * Compaction is non-destructive: it appends an assistant checkpoint and never
 * changes existing chat_messages rows. A failed model call is logged and leaves
 * the candidate thread untouched. Every compaction speaks a Notice into the
 * main thread so the operator returning to the session sees that it happened
 * rather than silently finding a shorter transcript.
 */

import { randomUUID } from 'node:crypto'
import { openDb } from '../lib/db.js'
import { PROVIDER_MODELS } from '../workers/provider-types.js'
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

/**
 * Minimum replay size, in tokens, before a transcript is compacted.
 *
 * 8,000 is deliberately the token equivalent of the 30,000-character gate this
 * replaces (the repo estimates 4 characters per token). Switching the UNIT is
 * the fix; moving the trigger point at the same time would have made a
 * behaviour change ride along invisibly with a units change.
 */
export const CHAT_COMPACTION_MIN_TOKENS = Number(process.env.MARS_CHAT_COMPACTION_MIN_TOKENS ?? 8_000)

/**
 * Token cost of one stored message.
 *
 * Prefers the provider's own accounting: an assistant turn carries a `result`
 * segment whose `inputTokens`/`outputTokens` are what the turn actually cost.
 * Messages with no such segment (every user message, and assistant messages
 * written before result segments existed) fall back to the length/4 estimate.
 */
const messageTokens = (message: ChatMessage): number => {
  const segments = message.segments
  if (Array.isArray(segments)) {
    const result = [...segments].reverse().find((segment): segment is Record<string, unknown> =>
      typeof segment === 'object' && segment !== null && !Array.isArray(segment)
      && (segment as Record<string, unknown>).type === 'result',
    )
    if (result) {
      const input = typeof result.inputTokens === 'number' ? Math.max(0, result.inputTokens) : 0
      const output = typeof result.outputTokens === 'number' ? Math.max(0, result.outputTokens) : 0
      if (input + output > 0) return input + output
    }
  }
  return Math.ceil(JSON.stringify(messageToApiInput(message)).length / 4)
}

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
      const replayTokens = postCheckpointMessages.reduce(
        (total, message) => total + messageTokens(message),
        0,
      )
      if (postCheckpointMessages.length === 0 || replayTokens < CHAT_COMPACTION_MIN_TOKENS) continue

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
        // The Notice tells the operator this happened. Compaction is the one
        // background action that silently changes what Mars remembers, so
        // leaving it unannounced means someone returning to the session cannot
        // tell a compacted thread from one that simply said less.
        //
        // It is written here, on the sweeper's own client and in the same batch
        // as the checkpoint, rather than through postConversationNotice: that
        // helper resolves its own state client from MARS_REPO, which would open
        // a second connection to a database this function was explicitly
        // parameterised away from by `dbTarget`. Batching also makes the pair
        // atomic — there is no window where history is folded away and nothing
        // says so. Its routing rule ("wait for a pause") is moot here anyway,
        // since the sweeper only ever touches threads that are already idle.
        const noticeId = randomUUID()
        const noticeBody = `I compacted "${candidate.title || 'this subthread'}" — ${postCheckpointMessages.length} message(s), about ${replayTokens.toLocaleString('en-US')} tokens, are now a checkpoint summary. Nothing was deleted.`
        const guard = `WHERE EXISTS (
                     SELECT 1 FROM chat_threads WHERE id = ? AND status = 'idle' AND updated_at = ?
                   )`
        const results = await client.batch([
          {
            sql: `UPDATE chat_threads SET updated_at = ?
                   WHERE id = ? AND status = 'idle' AND updated_at = ?`,
            args: [timestamp, candidate.id, candidate.updated_at],
          },
          {
            sql: `INSERT INTO chat_messages (id, thread_id, role, content, segments, created_at, kind, backing_entity_id)
                  SELECT ?, ?, 'assistant', ?, ?, ?, 'acknowledgment', NULL
                   ${guard}`,
            args: [checkpointId, candidate.id, summary, JSON.stringify([checkpoint]), timestamp, candidate.id, timestamp],
          },
          {
            // context_scope 'main' so the Notice lands in the main thread the
            // operator actually reads, not inside the subthread it describes.
            sql: `INSERT INTO chat_messages (id, thread_id, role, content, segments, created_at, context_scope, kind, backing_entity_id)
                  SELECT ?, ?, 'assistant', ?, ?, ?, 'main', 'notice', NULL
                   ${guard}`,
            args: [noticeId, candidate.id, noticeBody, JSON.stringify([{ type: 'text', text: noticeBody }]), timestamp, candidate.id, timestamp],
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
