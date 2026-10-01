/**
 * The one place the observational Notices are spoken.
 *
 * Detectors decide; this decides whether Mars is allowed to say it and then
 * says it. Keeping the two apart is what makes the detectors testable without
 * a chat store and makes the autonomy check impossible to forget: there is
 * exactly one call site per kind, and every one of them goes through
 * {@link allowed}.
 *
 * Everything here is `routine`. None of it is urgent by construction — an
 * observation about last fortnight's token spend has no business interrupting
 * a grill — so the delivery layer holds it until the operator is at a pause.
 */

import type { DbClient } from '../db.js'
import { postConversationNotice } from '../conversation-delivery.js'
import {
  ARCHITECTURE_REPORT_LEVER,
  CODEGRAPH_SUGGESTION_LEVER,
  IDLE_PROPOSAL_OFFER_LEVER,
  TRIAGE_YIELD_LEVER,
  UNVERIFIED_COMMITS_LEVER,
} from '../conversation-copy.js'
import { readLeverAutonomyLevel } from '../../daemon/config.js'
import { detectIdleProposal } from './idle-proposal.js'
import { detectTokenSpendTrend } from './token-spend-trend.js'
import { detectTriageYieldDrop } from './triage-yield.js'
import { detectManualPush } from './manual-push.js'
import { detectCodegraphSuggestion } from './codegraph-suggestion.js'

export interface NoticeSweepDeps {
  client: DbClient
  repoRoot: string
  integrationBranch: string
  /** Commits on a branch since an epoch-ms instant, newest first. */
  listCommits: (branch: string, sinceMs: number) => Promise<readonly string[]>
  /**
   * All SHAs reachable from `to` but not from `from` (git rev-list from..to).
   * Forwarded to `detectManualPush` to attribute multi-commit task branches.
   * Optional: when absent the detector falls back to exact tip-SHA matching.
   */
  listCommitRange?: (from: string, to: string) => Promise<readonly string[]>
  log?: (message: string) => void
  /** Override for testing — defaults to reading daemon.json. */
  readAutonomyLevel?: (lever: string) => string
  /** Override for testing — defaults to durable Notice delivery. */
  post?: typeof postConversationNotice
}

/** How many Notices the sweep spoke. */
export interface NoticeSweepResult {
  posted: number
}

export const runNoticeSweep = async (deps: NoticeSweepDeps): Promise<NoticeSweepResult> => {
  const { client, log } = deps
  const post = deps.post ?? postConversationNotice
  const readLevel = deps.readAutonomyLevel ?? readLeverAutonomyLevel

  /**
   * A lever the operator turned off silences its behaviour completely — the
   * detector does not even run. An unreadable lever silences it too: unlike
   * the host-protection tuner, nothing breaks if an observation goes unsaid,
   * so the safe direction here is quiet.
   */
  const allowed = (lever: string): boolean => {
    try {
      return readLevel(lever) !== 'off'
    } catch (err) {
      log?.(`[notice-sweep] lever '${lever}' unreadable, staying quiet: ${(err as Error).message}`)
      return false
    }
  }

  let posted = 0
  const speak = async (input: Parameters<typeof postConversationNotice>[0]): Promise<void> => {
    try {
      await post(input)
      posted += 1
    } catch (err) {
      log?.(`[notice-sweep] delivery failed: ${(err as Error).message}`)
    }
  }

  if (allowed(IDLE_PROPOSAL_OFFER_LEVER)) {
    const offer = await detectIdleProposal(client)
    if (offer) {
      await speak({ kind: 'session.idle-proposal', payload: offer, priority: 'routine' })
    }
  }

  if (allowed(CODEGRAPH_SUGGESTION_LEVER)) {
    const suggestion = await detectCodegraphSuggestion(client, { repoRoot: deps.repoRoot })
    if (suggestion) {
      await speak({ kind: 'suggestion.codegraph', payload: suggestion, priority: 'routine' })
    }
  }

  if (allowed(UNVERIFIED_COMMITS_LEVER)) {
    // Cooldown: skip if a manual-push notice was already posted within the
    // current observation window (14 days, matching the detector default).
    // We check conversation_pending_messages (the source-of-truth for all
    // posted notices, pending or delivered) and look for the lever name in
    // segments — a stable, content-free proxy for "this kind was posted".
    const windowMs = 14 * 24 * 60 * 60 * 1000
    const sinceMs = Date.now() - windowMs
    const recentPush = await client.execute({
      sql: `SELECT 1 FROM conversation_pending_messages
             WHERE segments LIKE ?
               AND created_at >= ?
             LIMIT 1`,
      args: [`%${UNVERIFIED_COMMITS_LEVER}%`, sinceMs],
    })
    if (recentPush.rows.length === 0) {
      const observation = await detectManualPush(client, {
        branch: deps.integrationBranch,
        listCommits: deps.listCommits,
        listCommitRange: deps.listCommitRange,
      })
      if (observation) {
        await speak({ kind: 'observation.manual-push', payload: observation, priority: 'routine' })
      }
    }
  }

  if (allowed(ARCHITECTURE_REPORT_LEVER)) {
    const trend = await detectTokenSpendTrend(client)
    if (trend) {
      await speak({
        kind: 'trend.token-spend',
        payload: { changePct: trend.changePct, windowDays: trend.windowDays },
        priority: 'routine',
      })
    }
  }

  if (allowed(TRIAGE_YIELD_LEVER)) {
    const drop = await detectTriageYieldDrop(client)
    if (drop) {
      await speak({
        kind: 'trend.triage-yield',
        payload: {
          recentRatePct: drop.recentRatePct,
          priorRatePct: drop.priorRatePct,
          recentCreated: drop.recentCreated,
          windowDays: drop.windowDays,
          topSource: drop.topSource ?? 'an unknown source',
        },
        priority: 'routine',
      })
    }
  }

  return { posted }
}
