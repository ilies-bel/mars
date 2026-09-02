/**
 * Automates the supersede-on-context-exhausted-recovery playbook.
 *
 * ## The manual playbook this replaces
 *
 * A recovery (kind=`fix`) task runs in the ORIGIN's worktree on the ORIGIN's
 * branch. When its coder is killed for exhausting its context budget
 * (`code:context-exhausted/...`, written by `tools/coder/coder-exit.ts`), the
 * kill handler auto-commits whatever was uncommitted as a salvage checkpoint
 * (`wip(checkpoint): ...` + a `Mars-Checkpoint: salvage` trailer) and the arc
 * dead-ends: the recovery escalates as `recovery_failed:`, the origin's single
 * recovery slot is spent, and the operator is left holding an action-queue row.
 *
 * At that point the operator's move is always the same, and always manual:
 *
 *     mars task add --supersede <origin-id> "<finish the work on that branch>"
 *
 * `--supersede` inherits the branch (and therefore every commit any coder has
 * landed on it, including the salvage checkpoint) onto a FRESH task with a
 * fresh context window. That is the only recovery shape that makes sense here:
 * the previous agent did not fail because it was wrong, it failed because it
 * ran out of room, so what it needs is more room — not a diagnosis.
 *
 * This module runs that playbook automatically from inside the failure handler.
 *
 * ## Exactly one supersede per exhaustion
 *
 * The superseding task is an ORDINARY origin task. If it also dies of context
 * exhaustion it will spawn its own recovery, and that recovery can exhaust in
 * turn — which would loop back into this module forever, each pass minting
 * another task on the same branch. {@link CONTEXT_EXHAUSTED_SUPERSEDE_DEDUP_PREFIX}
 * is the durable stop: the superseding task is written with a
 * `followup_dedup_key` of `context-exhausted-supersede:<arcOriginId>`, and this
 * module refuses to spawn when a row already carries that key. One automatic
 * supersede per ARC — a second exhaustion parks the arc exactly as it does
 * today, with the operator in the loop.
 *
 * The dedup-key-first pattern (query, then enqueue with the key) mirrors the
 * force-purge compensation path in `daemon/arc-purge.ts`; the column is indexed
 * (`idx_tasks_followup_dedup_key`).
 *
 * ## When this deliberately does NOT fire
 *
 * - The signature is not a context exhaustion → not this playbook.
 * - The branch already holds REAL (non-checkpoint) commits → the existing
 *   auto-remerge path in `queue-fix-tasks.ts` is strictly better: it lands the
 *   work rather than handing it to another coder. This module runs BEFORE that
 *   check precisely so the checkpoint-only case (which auto-remerge would send
 *   into the merge step's `code:salvage-checkpoint-tip/no-progress` refusal)
 *   is intercepted first.
 * - The origin is already terminal → the arc resolved on its own.
 * - A supersede was already spawned for this arc → see above.
 *
 * In every one of those cases the caller falls through to the unchanged
 * escalation path.
 */
import {
  getTask,
  MAX_PRIORITY,
  reopenTerminalTask,
  updateTask,
  type Task,
} from './queue'
import { getDefaultTaskStore, type DomainTaskStore } from './store/task-store-default'
import { removeBlockerEdge } from './arc/blockers'
import { hintDispatch } from './daemon/dispatch-hint'
import { isContextExhaustedSignature } from './lib/failure-signature'
import { integrationBranchName } from './lib/blocker-resolution-primitives'
import { getRepoRoot } from './context'
import { listUniqueCommitsAhead } from './lib/sweep'
import { SALVAGE_CHECKPOINT_SUBJECT_PREFIX } from './lib/salvage-checkpoint-subjects'
import type { OrphanCommit } from './lib/sweep'

/**
 * Prefix of the `followup_dedup_key` written on an automatically spawned
 * supersede task. The full key is `<prefix><arcOriginId>` — one per arc.
 */
const CONTEXT_EXHAUSTED_SUPERSEDE_DEDUP_PREFIX = 'context-exhausted-supersede:'

/** Tag carried by every task this module spawns, for trace/telemetry queries. */
const CONTEXT_EXHAUSTED_SUPERSEDE_TAG = 'context-exhausted-supersede'

/** Upper bound on the inlined origin prompt, so one huge prompt cannot dominate. */
const ORIGIN_PROMPT_LIMIT = 12_000

/** Upper bound on the number of branch commits rendered into the brief. */
const COMMIT_LIST_LIMIT = 20

export interface ContextExhaustedSupersedeInput {
  /** The recovery task (`fixForTaskId !== null`) that just failed. */
  failedRecovery: Task
  /** The computed `<step>/<class>` signature of that failure. */
  failureSignature: string
  store?: DomainTaskStore
}

export interface ContextExhaustedSupersedeResult {
  spawned: boolean
  /** Set when `spawned` is true. */
  supersedeTaskId?: string
  /** Why the spawn was declined. Set when `spawned` is false. */
  skipReason?:
    | 'not-context-exhausted'
    | 'no-origin'
    | 'origin-terminal'
    | 'already-superseded'
    | 'real-commits-ahead'
    | 'enqueue-failed'
}

const truncateForPrompt = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n\n…[origin prompt truncated]`

const isSalvageCheckpoint = (subject: string): boolean =>
  subject.startsWith(SALVAGE_CHECKPOINT_SUBJECT_PREFIX)

const formatCommits = (commits: readonly OrphanCommit[]): string =>
  commits
    .slice(0, COMMIT_LIST_LIMIT)
    .map((c) => `  ${c.shortSha} ${c.subject}`)
    .join('\n')

export interface SupersedePromptInput {
  /** Id of the origin task whose work is being carried forward. */
  originId: string
  /** Id of the recovery task that ran out of context. */
  exhaustedRecoveryId: string
  /** The branch the new task inherits, or null when nothing was ever created. */
  branch: string | null
  /** The integration branch the commit counts are relative to. */
  integrationBranch: string
  /** Commits on `branch` not in `integrationBranch`, newest first. */
  commitsAhead: readonly OrphanCommit[]
  /** True when the newest commit is an orchestrator salvage checkpoint. */
  tipIsSalvageCheckpoint: boolean
  /** The origin task's prompt, inlined verbatim (truncated if enormous). */
  originPrompt: string
}

/**
 * The prompt handed to the superseding coder.
 *
 * Three things it must carry, in this order, because a coder reads top-down and
 * the first thing it does with an inherited branch is the thing most likely to
 * go wrong:
 *
 *  1. **Branch tip state and the correct first action.** A coder dispatched onto
 *     a superseded branch otherwise has no signal that the commit at the tip is
 *     an auto-generated "do not merge as-is" snapshot. The instruction is
 *     explicitly *finish-or-reset*: either land a genuine commit on top of the
 *     salvaged diff, or throw it away and start clean — never build blindly on
 *     top of it and never leave another checkpoint at the tip (the merge step
 *     refuses to fast-forward a branch in that state).
 *  2. **The original goal, inlined.** The new coder is not recovering a bug; it
 *     is finishing the ORIGINAL task. Inlining the prompt saves it the database
 *     round-trip and the guesswork.
 *  3. **Context discipline.** The previous agent died of exactly the failure
 *     mode this section warns about, so the rules are stated as a diagnosis of
 *     what already happened rather than as generic boilerplate.
 */
export const buildContextExhaustedSupersedePrompt = (
  input: SupersedePromptInput,
): string => {
  const {
    originId,
    exhaustedRecoveryId,
    branch,
    integrationBranch,
    commitsAhead,
    tipIsSalvageCheckpoint,
    originPrompt,
  } = input

  const sections: string[] = [
    '# Context handoff — finish the work the previous agent ran out of room for',
    '',
    `Task \`${originId}\` failed, its recovery \`${exhaustedRecoveryId}\` was dispatched to fix it, ` +
      'and that recovery was killed mid-implementation when it exhausted its context budget ' +
      '(`code:context-exhausted`). It did not fail because it was wrong — it failed because it ran ' +
      'out of room. This task supersedes the origin: you inherit its branch, its commits, and its ' +
      'goal, with a fresh context window.',
    '',
    'This is the LAST automatic attempt on this arc. If you also run out of context the arc parks ' +
      'for a human, so treat your context budget as the scarce resource it is.',
    '',
    '## Branch tip state',
    '',
  ]

  if (branch === null) {
    sections.push(
      'No branch was ever recorded for the origin task, so there is nothing to inherit — you are ' +
        'starting from a clean base. Implement the original task below from scratch.',
    )
  } else if (commitsAhead.length === 0) {
    sections.push(
      `Branch \`${branch}\` has **no commits** ahead of \`${integrationBranch}\`. Neither the origin ` +
        'coder nor its recovery landed anything: every byte they wrote was lost when they were ' +
        'killed. You are starting from a clean base — implement the original task below from ' +
        'scratch, committing as you go so the same thing cannot happen to you.',
    )
  } else {
    sections.push(
      `Branch \`${branch}\` is **${commitsAhead.length} commit(s)** ahead of \`${integrationBranch}\`, ` +
        'newest first:',
      '',
      formatCommits(commitsAhead),
    )
    if (commitsAhead.length > COMMIT_LIST_LIMIT) {
      sections.push('', `  …and ${commitsAhead.length - COMMIT_LIST_LIMIT} more.`)
    }
    if (tipIsSalvageCheckpoint) {
      sections.push(
        '',
        `The tip is an orchestrator-authored **salvage checkpoint** (subject starts with ` +
          `\`${SALVAGE_CHECKPOINT_SUBJECT_PREFIX}\`). It is not a finished diff — it is a raw ` +
          '`git add -A` snapshot of whatever happened to be uncommitted at the instant the ' +
          'previous coder was killed. It may be half-written, may not compile, and the merge step ' +
          'REFUSES to fast-forward a branch whose tip is still one of these.',
        '',
        '**Your first action is finish-or-reset — pick one, do not build blindly on top:**',
        '',
        '1. Read it: `git log -p -1` for the salvaged diff, `git log --oneline` for the history below it.',
        '2. **Finish** it if it is a coherent partial step toward the goal — complete the change and ' +
          'land it as a genuine commit on top. Do not amend the checkpoint; leave it in the history.',
        '3. **Reset** it if it is incoherent or heads the wrong way — ' +
          '`git reset --hard HEAD~1` (repeat for each consecutive checkpoint at the tip) and start ' +
          'from the last real commit. Discarding a broken snapshot is cheaper than debugging it.',
        '4. Either way, the branch must NOT end on a checkpoint commit when you exit.',
      )
    } else {
      sections.push(
        '',
        'The tip is a real, coder-authored commit — build on it. Read `git log -p -1` before you ' +
          'start so you continue the previous attempt rather than redoing it.',
      )
    }
  }

  sections.push(
    '',
    '## The original task',
    '',
    'This is the goal, verbatim. Everything above is context about where the previous attempts got to.',
    '',
    '---',
    '',
    truncateForPrompt(originPrompt.trim(), ORIGIN_PROMPT_LIMIT),
    '',
    '---',
    '',
    '## Context discipline — this is what killed the previous two attempts',
    '',
    'Both prior agents ran until their context budget was gone. A kill loses only UNCOMMITTED work, ' +
      'so every commit you make is a piece of this task that can never be lost again. Work ' +
      'accordingly:',
    '',
    '1. **Commit incrementally, and commit early.** One commit per coherent unit — never accumulate ' +
      'a large uncommitted diff waiting for the whole task to be done. Make your first commit within ' +
      'the first few edits.',
    '2. **Read narrowly.** Do not re-read files a search already summarised, and do not dump whole ' +
      'directories into context. Prefer `codegraph`/`rg` over broad sweeps; read only the ranges you ' +
      'are about to edit.',
    '3. **Iterate against the narrowest test file first.** Run the full suite once, at the end.',
    '4. **Hand off before you die.** If the remaining scope clearly exceeds your remaining context, ' +
      'stop at a clean COMMITTED state and file the remainder with ' +
      `\`mars task add --blocked-by <this task id>\` describing exactly what is left. A graceful ` +
      'handoff at a clean commit beats a forced kill with uncommitted work — and it is the only ' +
      'outcome here that is not a dead arc.',
    '',
    'Save your work — the orchestrator does NOT commit on your behalf.',
  )

  return sections.join('\n')
}

/**
 * Spawn the superseding task for a recovery that died of context exhaustion,
 * or decline with a reason.
 *
 * Called from the recovery-failure branch of `handleTaskFailureWithFixTask`,
 * BEFORE the auto-remerge branch-tip check (see the module header for why that
 * ordering is load-bearing). When this returns `spawned: false` the caller
 * continues down the unchanged escalation path.
 *
 * On a successful spawn this also drops the exhausted recovery as `superseded`
 * and removes the origin→recovery blocker edge, mirroring what the auto-remerge
 * path does — the arc continues through the new task, not through either of the
 * two rows that just died.
 */
export const maybeSupersedeOnContextExhaustedRecovery = async (
  input: ContextExhaustedSupersedeInput,
): Promise<ContextExhaustedSupersedeResult> => {
  const { failedRecovery, failureSignature } = input
  const store = input.store ?? (await getDefaultTaskStore())

  if (!isContextExhaustedSignature(failureSignature)) {
    return { spawned: false, skipReason: 'not-context-exhausted' }
  }

  const originId = failedRecovery.fixForTaskId
  if (originId === null) return { spawned: false, skipReason: 'no-origin' }
  const origin = await getTask(originId, store)
  if (origin === null) return { spawned: false, skipReason: 'no-origin' }
  // 'done'/'dropped' mean the arc already resolved without us; superseding a
  // resolved origin would mint a task with nothing to do.
  if (origin.status === 'done' || origin.status === 'dropped') {
    return { spawned: false, skipReason: 'origin-terminal' }
  }

  // ── Exactly-one-supersede-per-exhaustion ────────────────────────────────
  // Checked against the ARC id, not the origin id: the superseding task shares
  // `origin_id` with everything else in the arc, so a second exhaustion further
  // down the chain sees the first supersede and declines.
  const dedupKey = `${CONTEXT_EXHAUSTED_SUPERSEDE_DEDUP_PREFIX}${origin.originId}`
  const existing = await store.query({
    sql: `SELECT id FROM tasks WHERE followup_dedup_key = ? LIMIT 1`,
    args: [dedupKey],
  })
  if (existing.rows.length > 0) {
    // eslint-disable-next-line no-console
    console.info(
      `[context-exhausted-supersede] arc ${origin.originId} already has supersede task ` +
        `${(existing.rows[0] as unknown as { id: string }).id} — parking as usual`,
    )
    return { spawned: false, skipReason: 'already-superseded' }
  }

  // ── Branch inspection ───────────────────────────────────────────────────
  // The recovery ran in the origin's worktree on the origin's branch, so either
  // row's `branch` names the same ref; prefer the origin's, which is the one
  // `--supersede` will actually inherit.
  const branch = origin.branch ?? failedRecovery.branch
  const integrationBranch = integrationBranchName()
  let commitsAhead: OrphanCommit[] = []
  if (branch !== null) {
    commitsAhead = await listUniqueCommitsAhead(branch, integrationBranch, getRepoRoot())
  }
  // Real commits ahead → the existing auto-remerge path lands them, which is
  // strictly better than handing them to another coder. Decline and fall
  // through to it.
  if (commitsAhead.some((c) => !isSalvageCheckpoint(c.subject))) {
    return { spawned: false, skipReason: 'real-commits-ahead' }
  }

  const prompt = buildContextExhaustedSupersedePrompt({
    originId,
    exhaustedRecoveryId: failedRecovery.id,
    branch,
    integrationBranch,
    commitsAhead,
    tipIsSalvageCheckpoint:
      commitsAhead.length > 0 && isSalvageCheckpoint(commitsAhead[0]!.subject),
    originPrompt: origin.prompt ?? '',
  })

  // `supersedes` performs the whole inheritance: it releases the origin's
  // worktree (keeping the branch), drops the origin as 'superseded', creates a
  // fresh worktree for the new task on that same branch, and derives the new
  // task's `origin_id` from the origin so the arc stays intact.
  //
  // `skipTriage: true` lands the row directly in 'queued' — every
  // machine-generated task the daemon enqueues from inside its own process does
  // this, because nothing surfaces a 'draft' row for triage from in here and it
  // would strand forever. MAX_PRIORITY matches recovery tasks: this resumes
  // already-started work and should preempt fresh queued tasks.
  let supersedeTask: Task
  try {
    supersedeTask = await store.enqueueTask(prompt, undefined, {
      skipTriage: true,
      supersedes: originId,
      followupDedupKey: dedupKey,
      priority: MAX_PRIORITY,
      tags: [CONTEXT_EXHAUSTED_SUPERSEDE_TAG],
      intent: `Finish ${originId} on a fresh context after recovery ${failedRecovery.id} exhausted its budget`,
    })
  } catch (err) {
    // A failed supersede leaves the origin dropped with no replacement (see the
    // `Arc.createOrigin` contract), which is exactly the state the escalation
    // path is built to surface. Decline rather than throw so the caller still
    // raises its action-queue row.
    // eslint-disable-next-line no-console
    console.error(
      `[context-exhausted-supersede] enqueue for origin ${originId} failed (non-fatal), escalating:`,
      err,
    )
    return { spawned: false, skipReason: 'enqueue-failed' }
  }

  // The arc now continues through `supersedeTask`. Retire the exhausted
  // recovery: drop the origin→recovery blocker edge first (the origin is
  // already 'dropped', so the edge is pure noise), then mark the recovery
  // 'superseded' with its worktree_path cleared — the directory it named was
  // removed by the supersede preamble.
  await removeBlockerEdge(store, originId, failedRecovery.id)
  // The row is usually ALREADY 'failed' by the time the failure handler runs
  // (`coder-exit.ts` stamps the failure before dispatching to it), and 'failed'
  // is terminal — a plain status write from it throws IllegalTransitionError.
  // Route through the audited reopen seam first, exactly as `Arc.createOrigin`
  // does for the superseded task itself, so the drop lands instead of being
  // swallowed as a "non-fatal" error and leaving a stale in-flight recovery.
  //
  // The reopen parks the row in 'queued' for the two awaits it takes to drop
  // it, so the dispatch loop could in principle claim it. That race is benign:
  // a claimed recovery runs `attachOriginWorktreeForFix`, which sees the origin
  // is already 'dropped' (the supersede just dropped it) and drops the recovery
  // itself as 'arc-rescued' before touching any worktree.
  if (failedRecovery.status === 'failed') {
    await reopenTerminalTask(
      failedRecovery.id,
      `superseded by ${supersedeTask.id} after context exhaustion`,
      store,
    )
  }
  await updateTask(
    failedRecovery.id,
    { status: 'dropped', dropReason: 'superseded', worktreePath: null },
    store,
  )

  // eslint-disable-next-line no-console
  console.log(
    `[context-exhausted-supersede] recovery ${failedRecovery.id} exhausted its context; ` +
      `spawned ${supersedeTask.id} superseding origin ${originId}` +
      (branch === null ? '' : ` on branch ${branch} (${commitsAhead.length} commit(s) ahead)`),
  )

  // Register with the daemon's in-memory dispatch loop. `enqueueTask` only
  // writes the database; without this the row waits for the boot reconciler.
  // No-op outside the daemon process (CLI, tests).
  hintDispatch(supersedeTask.id, 'implement')

  return { spawned: true, supersedeTaskId: supersedeTask.id }
}
