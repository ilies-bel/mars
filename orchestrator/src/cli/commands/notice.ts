/**
 * `notice` command group: `add`, `list`, and `ack`.
 *
 * A Notice (ADR-0079) is an entity-less informational bell message that clears
 * only when the operator acknowledges it.
 *
 * Transport mirrors `action-queue.ts`:
 *   - `list` and `ack` hit the daemon HTTP endpoints (`GET /notices`,
 *     `POST /notices/:id/ack`) via the shared `readDaemonPort` helper, so the
 *     CLI and UI render the same daemon-served view.
 *   - `add` writes through the store directly (like `action-queue raise`),
 *     since a fresh notice does not require the daemon to be running.
 */

import { createNotice } from '../../core/lib/notice-store'
import type { Command } from '../command'
import { errorMessage, readDaemonPort } from './shared'
import type { Notice } from '../../core/lib/notice-store'

const NO_DAEMON_MSG =
  'notice: daemon not running — run `mars daemon start` (notice list/ack are served by the daemon)'

const noticeAdd: Command = {
  path: 'notice add',
  summary: 'add an informational bell notice',
  usage: 'usage: mars notice add "<body>" [--source <s>]',
  run: async (args, deps) => {
    const body = args.positional[0]
    if (!body) {
      deps.err('usage: mars notice add "<body>" [--source <s>]')
      return { code: 2 }
    }
    const source = args.flags['--source'] ?? 'operator'
    try {
      const notice = await createNotice(body, source)
      deps.out(notice.id)
    } catch (err) {
      deps.err(`notice add: ${errorMessage(err)}`)
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const noticeList: Command = {
  path: 'notice list',
  summary: 'list open (unacknowledged) notices',
  usage: 'usage: mars notice list',
  run: async (_args, deps) => {
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let notices: Notice[]
    try {
      const res = await fetch(`http://127.0.0.1:${port}/notices`)
      if (!res.ok) throw new Error(`daemon returned ${res.status}`)
      const body = (await res.json()) as { notices: Notice[] }
      notices = body.notices
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    if (notices.length === 0) {
      deps.out('no open notices')
      return { code: 0 }
    }
    for (const notice of notices) {
      deps.out(`${notice.id}\t${notice.source ?? ''}\t${notice.body}`)
    }
    return { code: 0 }
  },
}

const noticeAck: Command = {
  path: 'notice ack',
  summary: 'acknowledge (clear) a notice',
  usage: 'usage: mars notice ack <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars notice ack <id>')
      return { code: 2 }
    }
    const port = await readDaemonPort(deps.ctx.stateDir)
    if (port === null) {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    let acknowledged: boolean
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/notices/${encodeURIComponent(id)}/ack`,
        { method: 'POST' },
      )
      if (!res.ok) throw new Error(`daemon returned ${res.status}`)
      const body = (await res.json()) as { acknowledged: boolean }
      acknowledged = body.acknowledged
    } catch {
      deps.err(NO_DAEMON_MSG)
      return { code: 1 }
    }
    if (acknowledged) {
      deps.out(`acknowledged ${id}`)
    } else {
      deps.out(`no open notice matching ${id}`)
    }
    return { code: 0 }
  },
}

/**
 * The bare `notice` (no subcommand) is an alias for `notice list` — the
 * bare-group fallback the registry arch-test requires.
 */
const noticeDefault: Command = {
  path: 'notice',
  summary: 'list open notices (alias for `list`)',
  usage: 'usage: mars notice [add "<body>" [--source <s>] | list | ack <id>]',
  run: (args, deps) => noticeList.run(args, deps),
}

export const noticeCommands: readonly Command[] = [
  noticeAdd,
  noticeList,
  noticeAck,
  noticeDefault,
]
