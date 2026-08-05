/**
 * Alert — the arc-rooted read aggregate (ADR-0054).
 *
 * An *Alert* is a pure, never-persisted projection of the two operator-facing
 * failure families: an arc whose every task is terminal-without-success
 * (`'arc-failed'`) and a leftover worktree whose task is terminal/absent
 * (`'stale-worktree'`). It is derived on read from arc state — there is no
 * `alerts` table, no row to write or close. The action queue's auto-close
 * machinery (the Invalidator) is the only thing that ever mutates persisted
 * action-queue rows; an Alert is computed fresh every time it is requested.
 *
 * {@link buildAlert} is the single pure derivation. {@link listAlerts} /
 * {@link showAlert} are thin use-cases that gather the raw inputs (failed arcs
 * + open stale-worktree rows) and run {@link buildAlert} over each. They take
 * an injectable {@link AlertSources} so the daemon can wire real stores and a
 * test can supply fakes — neither path writes anything.
 *
 * The arc key (`arcId`) is the arc's `origin_id`, resolved exactly like the
 * raise-side keying ({@link resolveOriginIdForTask}) so an Alert and the
 * action-queue row it shadows agree on which arc they describe.
 */

import {
  resolveFailureKind,
  type FailureKind,
} from './failure-kinds'
import { truncateFailure } from './truncate-failure'
import { resolveOriginIdForTask } from './origin'

/** The operator-facing failure families an Alert can describe. */
export type AlertKind = 'arc-failed' | 'stale-worktree' | 'verify-uncovered'

/**
 * A single descendant task in the arc, surfaced under the Alert's `technical`
 * detail so an operator can see the recovery chain that exhausted its options.
 */
export interface AlertDescendant {
  id: string
  status: string
}

/**
 * One node in the arc's Proposal-to-Attempt chain. Ordered oldest → newest:
 * proposal head (if any), origin task (attemptIndex=1), operator-initiated
 * restarts (attemptIndex=2, 3, …), automatic recovery descendants.
 */
export interface AlertChainNode {
  kind: 'proposal' | 'task'
  id: string
  status?: string
  label: string
  attemptIndex?: number
}

/**
 * The arc-rooted read aggregate. Pure projection — never persisted.
 *
 * The three text fields form a goal → reason → technical hierarchy:
 *   - `goal`      — what the arc was trying to achieve (the origin's intent).
 *   - `reason`    — the warm, human-readable cause (FailureKind copy).
 *   - `technical` — the raw signal (failing-step signature, trace tail,
 *                   descendant chain) for an operator who wants the detail.
 */
export interface Alert {
  arcId: string
  goal: string
  reason: string
  technical: string
  kind: AlertKind
  /** Action-queue identity for a coverage-gap alert. */
  fingerprint?: string
  /** Recovery recipe recorded with a coverage-gap alert, when supplied. */
  recipe?: string | null
  /** Ordered arc lineage: proposal head → origin attempt → restarts → recoveries. */
  chain: AlertChainNode[]
  /**
   * The structured failure signature of the tip task (the task that actually
   * holds the failure signal). Extracted from FailureKind.signature for
   * convenient rendering without parsing the `technical` blob.
   */
  failureSignature?: string
  /**
   * The pipeline phase in which the tip task failed (`'code'`, `'verify'`,
   * etc.). Null for non-failed tips or legacy rows where the column is absent.
   */
  failedPhase?: string | null
  /**
   * Number of tasks currently `blocked` whose blocker chain leads to this arc.
   * Omitted (undefined) when the count was not computed (e.g. stale-worktree
   * alerts). Zero means the arc is leaf-failing with no downstream dependents.
   */
  blockedCount?: number
}

/** Raw inputs {@link buildAlert} derives an {@link Alert} from. */
export interface BuildAlertInput {
  /** The arc's intent — the origin task prompt (one line is plenty). */
  goal: string
  /**
   * Tail of the captured failure output, already truncated upstream or here.
   * Empty string for a stale-worktree alert that has no failure trace.
   */
  traceTail: string
  /** The arc's descendant tasks (recovery / fix chain), oldest → newest. */
  descendants: readonly AlertDescendant[]
  /** Ordered arc lineage: proposal head → origin attempt → restarts → recoveries. */
  chain: AlertChainNode[]
  /**
   * Pipeline phase in which the tip task failed. Passed through to
   * {@link Alert.failedPhase}.
   */
  failedPhase?: string | null
  /**
   * Number of tasks blocked behind this arc. Passed through to
   * {@link Alert.blockedCount}.
   */
  blockedCount?: number
}

/** Collapse whitespace and clip a string to a single readable line. */
const oneLine = (s: string, max = 120): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/**
 * Render the descendant chain as a compact technical footnote. Empty string
 * when the arc has no descendants (a bare origin failure).
 */
const renderDescendants = (descendants: readonly AlertDescendant[]): string => {
  if (descendants.length === 0) return ''
  const chain = descendants.map((d) => `${d.id} (${d.status})`).join(' → ')
  return `recovery chain: ${chain}`
}

/**
 * The single PURE Alert derivation (ADR-0054). Builds the goal → reason →
 * technical hierarchy for one arc from its `failureKind`, captured trace tail,
 * and descendant chain. NEVER touches `action_queue_items` or any other store —
 * it is a data-in / data-out function with no I/O.
 *
 * Handles both Alert families via {@link FailureKind}:
 *   - `'arc-failed'`     — pass the real resolved FailureKind (e.g. from
 *                          `resolveFailureKind(signature, capturedError)`).
 *   - `'stale-worktree'` — pass `resolveFailureKind('stale-worktree/...', '')`
 *                          (or any FailureKind whose copy describes the stale
 *                          worktree); the warm copy still drives `reason`.
 *
 * `reason` uses `failureKind.verboseReason` (the warm humanReason) when present,
 * falling back to `warmTitle` so the reason line is never empty even for a
 * synthesised `unknownFailureKind`.
 */
export const buildAlert = (
  arcId: string,
  failureKind: FailureKind,
  traceTail: string,
  input: BuildAlertInput,
): Alert => {
  const kind: AlertKind = failureKind.signature.startsWith('stale-worktree')
    ? 'stale-worktree'
    : 'arc-failed'

  // reason: prefer the warm one-sentence humanReason; fall back to the short
  // title so the line is never empty.
  const reason =
    failureKind.verboseReason.trim().length > 0
      ? failureKind.verboseReason.trim()
      : failureKind.warmTitle.trim()

  // technical: the raw signal an operator drills into — signature + (tail) +
  // descendant chain. Assembled from non-empty parts only.
  const tail = truncateFailure(traceTail.trim(), 2000)
  const descendants = renderDescendants(input.descendants)
  const technical = [
    `signature: ${failureKind.signature}`,
    tail.length > 0 ? tail : null,
    descendants.length > 0 ? descendants : null,
  ]
    .filter((p): p is string => p !== null)
    .join('\n')

  return {
    arcId,
    goal: oneLine(input.goal),
    reason,
    technical,
    kind,
    chain: input.chain,
    failureSignature: failureKind.signature,
    failedPhase: input.failedPhase ?? null,
    blockedCount: input.blockedCount,
  }
}

/**
 * One raw failed-arc record the {@link listAlerts} use-case derives from.
 * The daemon builds these from its task store; a test can supply fakes.
 */
export interface FailedArcRecord {
  /** The arc id (origin_id). MUST already be resolved to the arc root. */
  arcId: string
  /** The origin task's intent (falling back to the prompt for legacy rows) — the arc's goal. */
  goal: string
  /** Structured failure signature written at failure time, or null. */
  failureSignature: string | null
  /** First captured error output, used to humanise an unregistered signature. */
  capturedError: string
  /** Tail of the captured failure output for the technical detail. */
  traceTail: string
  /** Descendant tasks in the arc (recovery / fix chain), oldest → newest. */
  descendants: AlertDescendant[]
  /**
   * Ordered arc lineage built by the AlertSources implementation. Head is the
   * originating proposal (if any), followed by origin task (attemptIndex=1),
   * operator-initiated restarts (attemptIndex=2, 3, …), then recovery tasks.
   * A lone task with no proposal and no restarts has a single-element chain.
   */
  chain: AlertChainNode[]
  /**
   * The pipeline phase in which the tip (failing) task failed (`'code'`,
   * `'verify'`, etc.). Null for legacy rows or non-failed tips.
   */
  failedPhase?: string | null
  /**
   * Number of tasks with status `'blocked'` that are blocked by any task in
   * this arc. Zero means the arc is leaf-failing with no downstream dependents.
   * Omitted when the count was not computed.
   */
  blockedCount?: number
}

/**
 * One raw open stale-worktree record the {@link listAlerts} use-case derives
 * from. Keyed by the worktree's task id, which the use-case resolves to its arc.
 */
export interface StaleWorktreeRecord {
  /** The worktree's task id (== the worktree directory name). */
  taskId: string
  /** The task prompt, or a synthesised label for an absent task. */
  prompt: string
  /** Worktree status snapshot (e.g. 'absent (no matching task)'). */
  status: string
  /** Hours since the worktree was last touched. */
  ageHours: number
}

/** One open action-queue coverage gap, keyed by its deduplicated fingerprint. */
export interface VerifyUncoveredRecord {
  fingerprint: string
  recipe: string | null
  scope: string
  changedPaths: string[]
}

/**
 * The injectable read sources for {@link listAlerts} / {@link showAlert}.
 * Pure-read by contract: implementations MUST NOT write to any store.
 */
export interface AlertSources {
  /** Enumerate every failed arc (every task terminal, none reached done). */
  listFailedArcs(): Promise<FailedArcRecord[]>
  /** Enumerate every open stale-worktree row. */
  listStaleWorktrees(): Promise<StaleWorktreeRecord[]>
  /** Enumerate every open verification coverage-gap row. */
  listVerifyUncovered(): Promise<VerifyUncoveredRecord[]>
}

/** The synthetic FailureKind signature prefix that marks a stale-worktree alert. */
const STALE_WORKTREE_SIGNATURE = 'stale-worktree/leftover'

/**
 * Build the FailureKind for a stale-worktree alert. There is no registered
 * entry for these, so we synthesise warm copy directly rather than routing
 * through `resolveFailureKind` (which would derive a generic pipeline-step
 * label from the prefix).
 */
const staleWorktreeFailureKind = (status: string, ageHours: number): FailureKind => ({
  signature: STALE_WORKTREE_SIGNATURE,
  warmTitle: 'A leftover worktree is taking up space',
  verboseReason: `A worktree from a terminal or absent task is still on disk (${status}, ~${Math.round(ageHours)}h old). Remove it once you have inspected anything you need.`,
  recipe: null,
  actions: [],
  // Housekeeping condition, not a code-failure class — nothing to encode.
  staticEncodable: { encodable: false, reason: 'environmental' },
})

/**
 * Derive a single {@link Alert} from a failed-arc record. Pure-ish: resolves
 * the FailureKind from the registry (a pure lookup) then runs {@link buildAlert}.
 */
const alertForFailedArc = (record: FailedArcRecord): Alert => {
  const failureKind = resolveFailureKind(
    record.failureSignature,
    record.capturedError,
  )
  return buildAlert(record.arcId, failureKind, record.traceTail, {
    goal: record.goal,
    traceTail: record.traceTail,
    descendants: record.descendants,
    chain: record.chain,
    failedPhase: record.failedPhase,
    blockedCount: record.blockedCount,
  })
}

/**
 * Derive a single {@link Alert} from a stale-worktree record. The arc key is
 * the worktree task id resolved to its arc root, so the Alert agrees with the
 * raise-side keying.
 */
const alertForStaleWorktree = async (
  record: StaleWorktreeRecord,
): Promise<Alert> => {
  const arcId = await resolveOriginIdForTask(record.taskId)
  const failureKind = staleWorktreeFailureKind(record.status, record.ageHours)
  return buildAlert(arcId, failureKind, '', {
    goal: record.prompt,
    traceTail: '',
    descendants: [],
    chain: [],
  })
}

/** Project one open coverage gap into the Bell's goal → reason → evidence shape. */
const alertForVerifyUncovered = (record: VerifyUncoveredRecord): Alert => ({
  // Alert routes use `arcId` as their stable identity. Coverage gaps have no
  // arc, so their action-queue fingerprint is the stable, deduplicated key.
  arcId: record.fingerprint,
  goal: oneLine(record.scope),
  reason: "CAN'T-VERIFY: no task-tier verify gate covers the changed files",
  technical: record.changedPaths.length > 0
    ? `changed paths:\n${record.changedPaths.map((path) => `- ${path}`).join('\n')}`
    : 'changed paths: unavailable',
  kind: 'verify-uncovered',
  fingerprint: record.fingerprint,
  recipe: record.recipe,
  chain: [],
})

/**
 * List every current Alert (failed arcs + open stale worktrees). Pure read:
 * gathers the raw inputs from the injected {@link AlertSources} and runs
 * {@link buildAlert} over each. Never persists.
 */
export const listAlerts = async (sources: AlertSources): Promise<Alert[]> => {
  const [failedArcs, staleWorktrees, uncoveredVerify] = await Promise.all([
    sources.listFailedArcs(),
    sources.listStaleWorktrees(),
    sources.listVerifyUncovered(),
  ])
  const arcAlerts = failedArcs.map(alertForFailedArc)
  const staleAlerts = await Promise.all(staleWorktrees.map(alertForStaleWorktree))
  return [...arcAlerts, ...staleAlerts, ...uncoveredVerify.map(alertForVerifyUncovered)]
}

/**
 * Build the Alert for a single arc id, or null when no Alert applies (the arc
 * is not failed and has no open stale worktree keyed to it). Pure read.
 */
export const showAlert = async (
  arcId: string,
  sources: AlertSources,
): Promise<Alert | null> => {
  const all = await listAlerts(sources)
  return all.find((a) => a.arcId === arcId) ?? null
}
