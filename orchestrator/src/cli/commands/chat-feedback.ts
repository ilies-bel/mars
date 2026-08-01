/**
 * `chat-feedback` command group — read-only inspection of rated chat exchanges.
 *
 * Subcommands:
 *   chat-feedback list  — list feedback entries in a terminal table
 *
 * This is the operator's read surface for understanding what to steer before
 * editing `.mars/chat-system-prompt.md`. The data is populated by
 * `setMessageFeedback` / `clearMessageFeedback` in chat-store.ts whenever the
 * user gives a thumbs-up or thumbs-down on a chat reply.
 */

import type { Command } from '../command'

const chatFeedbackGroup: Command = {
  path: 'chat-feedback',
  summary: 'inspect rated chat feedback entries',
  usage: 'usage: mars chat-feedback <list>',
  run: (_, deps) => {
    deps.err('usage: mars chat-feedback <list>')
    deps.err('')
    deps.err('  list   [--rating up|down] [--limit N] [--since <iso>]')
    return { code: 2 }
  },
}

const chatFeedbackList: Command = {
  path: 'chat-feedback list',
  summary: 'list rated chat feedback entries',
  usage:
    'usage: mars chat-feedback list [--rating up|down] [--limit N] [--since <iso>]',
  run: async (args, deps) => {
    const ratingRaw = args.flags['--rating']
    if (ratingRaw !== undefined && ratingRaw !== 'up' && ratingRaw !== 'down') {
      deps.err(`--rating must be 'up' or 'down'; got '${ratingRaw}'`)
      return { code: 1 }
    }

    const limitRaw = args.flags['--limit']
    const limit = limitRaw !== undefined ? Number(limitRaw) : 50
    if (!Number.isFinite(limit) || limit <= 0) {
      deps.err('--limit must be a positive integer')
      return { code: 1 }
    }

    const since = args.flags['--since']
    const sinceMs = since === undefined ? undefined : Date.parse(since)
    if (since !== undefined && Number.isNaN(sinceMs)) {
      deps.err(`--since must be an ISO timestamp; got '${since}'`)
      return { code: 1 }
    }

    const { loadChatFeedback } = await import('../../core/lib/chat-feedback-query')

    const entries = await loadChatFeedback({
      rating: ratingRaw as 'up' | 'down' | undefined,
      limit,
      sinceMs,
    })

    if (entries.length === 0) {
      deps.out('no chat feedback entries found')
      return { code: 0 }
    }

    const COL_DATE = 10
    const COL_RATING = 6
    const COL_THREAD = 12
    const COL_NOTE = 20
    const COL_PROMPT = 40

    deps.out(
      `${'date'.padEnd(COL_DATE)} ${'rating'.padEnd(COL_RATING)} ${'thread'.padEnd(COL_THREAD)} ${'note'.padEnd(COL_NOTE)} prompt`,
    )
    deps.out(
      `${'----'.padEnd(COL_DATE)} ${'------'.padEnd(COL_RATING)} ${'------'.padEnd(COL_THREAD)} ${'----'.padEnd(COL_NOTE)} ------`,
    )

    for (const e of entries) {
      const date = new Date(e.createdAt).toISOString().slice(0, COL_DATE).padEnd(COL_DATE)
      const rating = e.rating.padEnd(COL_RATING)
      const thread = e.threadId.slice(0, COL_THREAD).padEnd(COL_THREAD)
      const rawNote = e.note ?? ''
      const note =
        rawNote.length > COL_NOTE
          ? `${rawNote.slice(0, COL_NOTE - 1)}…`
          : rawNote.padEnd(COL_NOTE)
      const promptText = e.userPrompt || '(no preceding user message)'
      const prompt =
        promptText.length > COL_PROMPT
          ? `${promptText.slice(0, COL_PROMPT - 1)}…`
          : promptText
      deps.out(`${date} ${rating} ${thread} ${note} ${prompt}`)
    }

    return { code: 0 }
  },
}

export const chatFeedbackCommands: readonly Command[] = [
  chatFeedbackGroup,
  chatFeedbackList,
]
