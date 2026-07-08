/**
 * `scorer` command group — entity verbs over the `scorers` table in
 * .mars/mars.db (PRD 6988ed3b).
 *
 * A Scorer is a per-Workflow quality rubric suggested by per-arc reflection
 * (`mars arc reflect`) when it finds a measurement gap the verify gate cannot
 * see. Triage is entity-verb only (ADR-0048 pure projection): `accept` /
 * `dismiss` transition the scorers row and the daemon's repopulator closes
 * the 'scorer-suggested' action-queue row off the resulting bus event. There
 * is no queue-side close verb.
 *
 * Accepting produces a durable accepted record and runs nothing — execution
 * against future Workflow instances belongs to the dependent draft 6cf85bc9.
 */

import {
  getScorer,
  listScorers,
  acceptScorer,
  dismissScorer,
  type Scorer,
  type ScorerStatus,
} from '../../core/scorers'
import { isDaemonReachable } from '../../core/daemon/paths'
import type { Command, CommandDeps } from '../command'
import { errorMessage } from './shared'

const isScorerStatus = (raw: string): raw is ScorerStatus =>
  raw === 'suggested' || raw === 'accepted' || raw === 'dismissed'

const renderScorerDetail = (deps: CommandDeps, scorer: Scorer): void => {
  deps.out(`id:               ${scorer.id}`)
  deps.out(`status:           ${scorer.status}`)
  deps.out(`workflow:         ${scorer.workflow}`)
  deps.out(`output contract:  continuous score in 0..1 + one-line rationale (${scorer.outputContract})`)
  deps.out(`confidence:       ${scorer.confidence.toFixed(2)}`)
  deps.out(`origin arc:       ${scorer.originArcId}`)
  if (scorer.reportPath) deps.out(`report:           ${scorer.reportPath}`)
  deps.out(`createdAt:        ${new Date(scorer.createdAt).toISOString()}`)
  deps.out(`updatedAt:        ${new Date(scorer.updatedAt).toISOString()}`)
  deps.out(`title:`)
  deps.out(scorer.title)
  deps.out(`rubric:`)
  deps.out(scorer.rubric)
  if (scorer.evidence.length > 0) {
    deps.out(`evidence:`)
    scorer.evidence.forEach((e, i) => deps.out(`  [${i}] ${e}`))
  }
}

/**
 * Shared daemon-down notice for the two triage verbs: the entity transition
 * has committed, but the projection (the open 'scorer-suggested' row) only
 * clears when the daemon drains the scorer.* event from the outbox.
 */
const noticeIfDaemonDown = async (
  deps: CommandDeps,
  scorerId: string,
): Promise<void> => {
  if (!(await isDaemonReachable(deps.ctx.stateDir))) {
    deps.err(
      `scorer ${scorerId} updated; the action-queue row will clear when the daemon next runs (daemon not running — run \`mars daemon start\`).`,
    )
  }
}

const scorerList: Command = {
  path: 'scorer list',
  summary: 'list scorers; filter by status and/or workflow',
  usage:
    'usage: mars scorer list [--status suggested|accepted|dismissed] [--workflow <kind>]',
  run: async (args, deps) => {
    const statusFlag = args.flags['--status']
    if (statusFlag !== undefined && !isScorerStatus(statusFlag)) {
      deps.err(
        `--status must be one of: suggested|accepted|dismissed; got '${statusFlag}'`,
      )
      return { code: 1 }
    }
    const filter: { status?: ScorerStatus; workflow?: string } = {}
    if (statusFlag !== undefined && isScorerStatus(statusFlag)) {
      filter.status = statusFlag
    }
    const workflowFlag = args.flags['--workflow']
    if (workflowFlag) filter.workflow = workflowFlag
    const scorers = await listScorers(filter)
    if (scorers.length === 0) {
      deps.out('no scorers')
      return { code: 0 }
    }
    for (const s of scorers) {
      deps.out(
        `${s.id.slice(0, 8)}\t${s.status}\tworkflow=${s.workflow}\tconfidence=${s.confidence.toFixed(2)}\t${s.title}`,
      )
    }
    return { code: 0 }
  },
}

const scorerShow: Command = {
  path: 'scorer show',
  summary: 'show a scorer in full (rubric, contract, provenance, evidence)',
  usage: 'usage: mars scorer show <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars scorer show <id>')
      return { code: 1 }
    }
    const scorer = await getScorer(id)
    if (!scorer) {
      deps.err(`scorer ${id} not found`)
      return { code: 1 }
    }
    renderScorerDetail(deps, scorer)
    return { code: 0 }
  },
}

const scorerAccept: Command = {
  path: 'scorer accept',
  summary: 'accept a suggested scorer (durable record; nothing runs)',
  usage: 'usage: mars scorer accept <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars scorer accept <id>')
      return { code: 1 }
    }
    try {
      const scorer = await acceptScorer(id)
      deps.out(`accepted ${scorer.id}`)
      await noticeIfDaemonDown(deps, scorer.id)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const scorerDismiss: Command = {
  path: 'scorer dismiss',
  summary: 'dismiss a suggested scorer',
  usage: 'usage: mars scorer dismiss <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars scorer dismiss <id>')
      return { code: 1 }
    }
    try {
      const scorer = await dismissScorer(id)
      deps.out(`dismissed ${scorer.id}`)
      await noticeIfDaemonDown(deps, scorer.id)
    } catch (error: unknown) {
      deps.err(errorMessage(error))
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const scorerGroup: Command = {
  path: 'scorer',
  summary: 'scorer subcommands',
  usage: 'usage: mars scorer <list|show|accept|dismiss> ...',
  run: (_args, deps) => {
    deps.err('usage: mars scorer <list|show|accept|dismiss> ...')
    return { code: 1 }
  },
}

export const scorerCommands: readonly Command[] = [
  scorerList,
  scorerShow,
  scorerAccept,
  scorerDismiss,
  scorerGroup,
]
