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
 * Accepting makes the Scorer live: the daemon grades every subsequent
 * completed instance of its target workflow post-merge (record-only, PRD
 * 6cf85bc9); `trend` reads the per-workflow median + p90 over the results.
 */

import {
  getScorer,
  listScorers,
  acceptScorer,
  dismissScorer,
  type Scorer,
  type ScorerStatus,
} from '../../core/scorers'
import {
  computeScorerTrend,
  listScorerResults,
  listScoredWorkflows,
  type ScorerTrend,
} from '../../core/scorer-results'
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
    // Runtime surface (PRD 6cf85bc9): recent recorded results, newest first.
    const results = await listScorerResults({ scorerId: scorer.id, limit: 5 })
    if (results.length > 0) {
      deps.out(`recent results:`)
      for (const r of results) {
        const scoreText =
          r.status === 'scored' && r.score !== null
            ? r.score.toFixed(2)
            : 'error'
        deps.out(
          `  ${new Date(r.createdAt).toISOString()}\ttask=${r.taskId}\tscore=${scoreText}\t${r.rationale}`,
        )
      }
    }
    return { code: 0 }
  },
}

const renderTrendLine = (deps: CommandDeps, t: ScorerTrend): void => {
  const fmt = (n: number | null): string => (n === null ? 'n/a' : n.toFixed(2))
  deps.out(
    `${t.workflow}\tn=${t.sampleCount}\tmedian=${fmt(t.median)}\tp90=${fmt(t.p90)}\tlatest=${fmt(t.latest)}${
      t.errorCount > 0 ? `\terrors=${t.errorCount}` : ''
    }`,
  )
}

const scorerTrend: Command = {
  path: 'scorer trend',
  summary:
    'per-workflow score trend: median + p90 over a trailing window (never a bare mean)',
  usage: 'usage: mars scorer trend [--workflow <kind>] [--window <n>]',
  run: async (args, deps) => {
    const windowFlag = args.flags['--window']
    let window = 20
    if (windowFlag !== undefined) {
      const n = Number.parseInt(windowFlag, 10)
      if (!Number.isInteger(n) || n <= 0) {
        deps.err(`--window must be a positive integer; got '${windowFlag}'`)
        return { code: 1 }
      }
      window = n
    }
    const workflowFlag = args.flags['--workflow']
    const workflows = workflowFlag
      ? [workflowFlag]
      : await listScoredWorkflows()
    if (workflows.length === 0) {
      deps.out('no scorer results recorded yet')
      return { code: 0 }
    }
    for (const workflow of workflows) {
      const trend = await computeScorerTrend(workflow, window)
      renderTrendLine(deps, trend)
    }
    // Single-workflow view also lists the window's rows so the operator can
    // read rationales without a second command.
    if (workflowFlag) {
      const results = await listScorerResults({
        workflow: workflowFlag,
        limit: window,
      })
      for (const r of results) {
        const scoreText =
          r.status === 'scored' && r.score !== null
            ? r.score.toFixed(2)
            : 'error'
        deps.out(
          `  ${new Date(r.createdAt).toISOString()}\ttask=${r.taskId}\tscorer=${r.scorerId.slice(0, 8)}\tscore=${scoreText}\t${r.rationale}`,
        )
      }
    }
    return { code: 0 }
  },
}

const scorerAccept: Command = {
  path: 'scorer accept',
  summary:
    'accept a suggested scorer (future instances of its workflow are graded post-merge, record-only)',
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
  usage: 'usage: mars scorer <list|show|accept|dismiss|trend> ...',
  run: (_args, deps) => {
    deps.err('usage: mars scorer <list|show|accept|dismiss|trend> ...')
    return { code: 1 }
  },
}

export const scorerCommands: readonly Command[] = [
  scorerList,
  scorerShow,
  scorerAccept,
  scorerDismiss,
  scorerTrend,
  scorerGroup,
]
