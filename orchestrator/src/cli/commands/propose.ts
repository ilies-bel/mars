/**
 * `mars propose <verb> [args...]`
 *
 * Pure stdout emitter — performs NO mutations, NO Postgres writes, NO daemon
 * HTTP calls. Prints a single-line JSON envelope describing the proposed
 * destructive verb so the confirm gate can render it as a parked tool call.
 *
 * Exit codes:
 *   0  — valid verb; JSON envelope written to stdout
 *   2  — unknown verb (usage error); message written to stderr
 */

import type { Command } from '../command'
import { DESTRUCTIVE_MARS_VERBS } from '../../core/lib/chat-mars-verbs'

const proposeGroup: Command = {
  path: 'propose',
  summary: 'emit a proposal envelope for a destructive verb (no side effects)',
  usage: `usage: mars propose <verb> [args...]

Valid verbs: ${DESTRUCTIVE_MARS_VERBS.join(', ')}`,
  run: (args, deps) => {
    const verb = args.positional[0]
    if (!verb) {
      deps.err('usage: mars propose <verb> [args...]')
      deps.err('')
      deps.err(`Valid verbs: ${DESTRUCTIVE_MARS_VERBS.join(', ')}`)
      return { code: 2 }
    }

    if (!DESTRUCTIVE_MARS_VERBS.includes(verb)) {
      deps.err(
        `[mars propose] unknown verb '${verb}'; must be one of: ${DESTRUCTIVE_MARS_VERBS.join(', ')}`,
      )
      return { code: 2 }
    }

    const restArgs = args.positional.slice(1)
    const proposalId = crypto.randomUUID()
    const envelope = JSON.stringify({ kind: 'mars-propose', verb, args: restArgs, proposalId })
    deps.out(envelope)
    return { code: 0 }
  },
}

export const proposeCommands: readonly Command[] = [proposeGroup]
