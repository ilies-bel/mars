/**
 * `notice add` posts a template-authored, zero-token conversation entry.
 */

import { createNotice } from '../../core/lib/notice-store'
import { isActionQueueKind } from '../../core/lib/action-queue-kinds'
import type { Command } from '../command'
import { errorMessage } from './shared'

const noticeAdd: Command = {
  path: 'notice add',
  summary: 'post an informational conversation notice',
  usage: 'usage: mars notice add <kind> [--payload <json>] [--source <s>] [--priority urgent|routine]',
  run: async (args, deps) => {
    const kind = args.positional[0]
    if (!isActionQueueKind(kind)) {
      deps.err('usage: mars notice add <kind> [--payload <json>] [--source <s>] [--priority urgent|routine]')
      return { code: 2 }
    }
    let payload: Record<string, unknown> = {}
    const rawPayload = args.flags['--payload']
    if (rawPayload) {
      try {
        const parsed: unknown = JSON.parse(rawPayload)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
        payload = parsed as Record<string, unknown>
      } catch {
        deps.err('notice add: --payload must be a JSON object')
        return { code: 2 }
      }
    }
    const source = args.flags['--source'] ?? 'operator'
    const priority = args.flags['--priority'] ?? 'routine'
    if (priority !== 'urgent' && priority !== 'routine') {
      deps.err('notice add: --priority must be urgent or routine')
      return { code: 2 }
    }
    try {
      const notice = await createNotice(kind, payload, source, priority)
      deps.out(notice.id)
    } catch (err) {
      deps.err(`notice add: ${errorMessage(err)}`)
      return { code: 1 }
    }
    return { code: 0 }
  },
}

export const noticeCommands: readonly Command[] = [
  noticeAdd,
]
