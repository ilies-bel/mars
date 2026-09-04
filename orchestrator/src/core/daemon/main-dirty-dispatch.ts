/**
 * Slice F.2 / Slice 2: dispatch-time integration with the dirty-main detection helper.
 *
 * This module is a thin orchestration shim that the daemon's
 * `dispatchImplement` calls right before invoking `runWorkflow`. It
 * (1) classifies the integration branch via `classifyIntegrationDirtState`,
 * (2) on 'clean', returns false (dispatch proceeds normally),
 * (3) on 'committer-scope', looks up the `main-commiter` recipe and calls
 *     `spawnOrAttachMainCommitter` to park the task behind a recovery,
 * (4) on 'unrelated', raises a high-priority action-queue alert and returns
 *     true without inserting a fix task or task_blockers edge.
 *
 * Stays daemon-side (not workflow-side) because the daemon owns the
 * integration-branch repo root and is the right writer for the
 * recovery-task INSERT. The verify-time check ships separately, inside
 * the workflow's verify step.
 *
 * ADR-0100 slice 12: narrowing to the residual case. `classifyIntegrationDirtState`
 * still separates 'unrelated' dirt (ignored entries, conflicts, submodule
 * gitlinks — nothing a committer or an auto-commit can resolve; always blocks,
 * unchanged) from 'committer-scope' dirt (modified tracked files, plain
 * untracked files). For 'committer-scope' dirt specifically, the system now
 * handles two shapes on its own: stale-tree debris (the primary checkout is
 * one merge behind its own HEAD — the merge path's post-merge re-sync resets
 * it) and auto-committable operator dirt (the merge step sweeps it into a
 * `wip(operator)` commit when the `operatorAutoCommit` lever is on). Before
 * parking dispatch behind a fresh committer, `attributeIntegrationDirt`
 * classifies which of those it is; only dirt it cannot explain (operator-dirt)
 * with the lever off is the genuine residual that still needs to block.
 *
 * Incident 2026-08-23 (fix-a2c0a8ef): `attributeIntegrationDirt` only compares
 * the observed dirt against the inverse of the single `lastSyncedSha..headSha`
 * range. When the primary checkout falls MULTIPLE merges behind its own HEAD
 * (observed: three merges) and/or `.mars/last-synced-sha` is stale or unset,
 * that comparison fails safe to `operator-dirt` even though the working tree
 * is still just a rewind — byte-identical to some earlier commit already
 * reachable from HEAD, never a forward operator edit. A naive committer would
 * have happily "cleaned" that tree by committing the inverse of three good
 * commits (an ADR-0100 slice and a diagnosed test-hang fix) straight onto
 * `main`. Before trusting an `operator-dirt` verdict, this module now runs a
 * second, unconditional, structural check (`findRewoundAncestorSha` below):
 * does the working tree exactly match ANY recent ancestor of HEAD, not just
 * `lastSyncedSha`? A match is a rewind, full stop — commit or discard is
 * never the right call, only proceeding to dispatch and letting the merge
 * path's normal re-sync catch the checkout up.
 */
import { resolveContext } from '../context'
import {
  classifyIntegrationDirtState,
  MAIN_COMMITER_RECIPE,
  spawnOrAttachMainCommitter,
  type IntegrationBranchDirtyResult,
} from '../lib/main-dirty'
import {
  clearUnrelatedDirtActionQueue,
  raiseUnrelatedDirtActionQueue,
} from './main-dirty-action-queue'
import { resolveOriginIdForTask } from '../lib/origin'
import type { TraceCtx } from '../lib/run-tool'
import { resolveVcs } from '../ports/vcs/registry'
import { resolveControlLevers, isOperatorAutoCommitDisabled } from '../config/levers'
import { staleTreeRewindSearchDepth } from '../config/tuning'
import type { RecipeCatalog } from '../lib/recipes'
import type { TraceEventStore } from '../lib/trace-events-store'
import type { Task } from '../queue'

const STALE_TREE_REWIND_SEARCH_DEPTH = staleTreeRewindSearchDepth()

/**
 * Structural rewind check, independent of `.mars/last-synced-sha`.
 *
 * `attributeIntegrationDirt` only proves staleness against ONE specific
 * range (`lastSyncedSha..headSha`). This check asks a cheaper, more general
 * question: is the working tree byte-identical to ANY of HEAD's recent
 * ancestors? If so, the dirt is provably a rewind — never a forward operator
 * edit — regardless of whether `lastSyncedSha` was recorded correctly. See
 * the module doc comment (incident 2026-08-23 / fix-a2c0a8ef) for the
 * failure this closes.
 *
 * Untracked (`??`) paths are excluded from consideration up front: a
 * fast-forward re-sync never leaves untracked files behind, so their
 * presence means this is not a pure rewind no matter what `git diff`
 * reports for the tracked files.
 *
 * Returns the matching ancestor SHA, or `null` when the tree does not match
 * any of the searched ancestors (including when git itself fails — fail
 * safe by reporting no match rather than risk a false positive).
 */
export const findRewoundAncestorSha = async (input: {
  repoRoot: string
  headSha: string
  traceCtx?: TraceCtx
}): Promise<string | null> => {
  const { repoRoot, headSha } = input
  const vcs = resolveVcs()

  const status = await vcs.status({ cwd: repoRoot, untrackedFiles: 'all' })
  const hasUntracked = status.statusOutput
    .split('\n')
    .some((line) => line.slice(0, 2) === '??')
  if (hasUntracked) return null

  const candidates = (
    await vcs.recentShas({ cwd: repoRoot, rev: headSha, count: STALE_TREE_REWIND_SEARCH_DEPTH })
  ).filter((sha) => sha !== headSha)

  for (const candidate of candidates) {
    // `workingTreeMatches` is true when the working tree (index included)
    // matches <candidate> exactly, false on any difference (content or mode).
    if (await vcs.workingTreeMatches({ cwd: repoRoot, rev: candidate })) return candidate
  }
  return null
}

export interface MainDirtyDispatchInput {
  task: Task
  integrationBranch: string
  traceStore: TraceEventStore
  recipeCatalog: RecipeCatalog
  log: (msg: string) => void
}

/** Structured result from the dispatch-time dirty-main probe. */
export type MainDirtyDispatchResult =
  | { parked: false }
  | { parked: true; fixTaskId: string; spawned: boolean }
  | { parked: true; reason: 'unrelated-dirt'; actionQueueItemId: string }

/**
 * Run the dispatch-time dirty-main probe. Returns `{ parked: false }` when:
 * - the integration branch is clean;
 * - committer-scope dirt attributes to `stale-tree-debris` (the checkout is
 *   one merge behind its own HEAD — the merge path's re-sync resets it);
 * - committer-scope dirt attributes to `operator-dirt` but the
 *   `operatorAutoCommit` lever is on (the merge step will auto-commit it); or
 * - the recipe is missing from the catalog (verify-time check still applies).
 *
 * Returns `{ parked: true, fixTaskId, spawned }` when the task was parked
 * behind a `main-commiter` recovery and the caller must NOT dispatch the
 * workflow. `spawned` is true only when a NEW committer was inserted; the
 * caller is responsible for emitting `task.queued` for `fixTaskId` so the
 * dispatch loop picks it up without waiting for the next daemon restart.
 *
 * Returns `{ parked: true, reason: 'unrelated-dirt', actionQueueItemId }` when
 * the dirty state cannot be resolved by a committer (ignored entries, conflicts,
 * submodule changes). An action-queue alert is raised; no fix task is inserted.
 *
 * Done committers no longer suppress parking (invariant 2): a done committer
 * proves main was clean when it verified, but if main is dirty again a fresh
 * committer must clean it. The source task is parked behind the fresh committer.
 */
export const runMainDirtyDispatchCheck = async (
  input: MainDirtyDispatchInput,
): Promise<MainDirtyDispatchResult> => {
  const { task, integrationBranch, traceStore, recipeCatalog, log } = input
  const { repoRoot } = resolveContext()
  const originId = await resolveOriginIdForTask(task.id).catch(() => task.id)

  const classifyResult = await classifyIntegrationDirtState({
    repoRoot,
    integrationBranch,
    traceCtx: {
      taskId: task.id,
      originId,
      phase: 'setup',
      store: traceStore,
    },
  })

  if (classifyResult.kind === 'clean') {
    await clearUnrelatedDirtActionQueue(integrationBranch)
    return { parked: false }
  }

  if (classifyResult.kind === 'unrelated') {
    const actionQueueItemId = await raiseUnrelatedDirtActionQueue(
      integrationBranch,
      classifyResult.contaminatedPaths,
      log,
    )
    return { parked: true, reason: 'unrelated-dirt', actionQueueItemId }
  }

  // kind === 'committer-scope': dirty files a committer can stage and commit.
  //
  // Before parking behind a committer, ask whether this dirt is the residual
  // the guard exists for, or one of the two shapes the system now handles on
  // its own (see the module doc comment, ADR-0100 slice 12).
  const headSha = await resolveVcs().revParse({ cwd: repoRoot, rev: 'HEAD' })
  if (headSha !== null) {
    const lastSyncedSha = await resolveVcs().readLastSyncedSha({ cwd: repoRoot })
    const attribution = await resolveVcs().attributeIntegrationDirt({
      repoRoot,
      lastSyncedSha,
      headSha,
    })

    if (attribution.kind === 'clean' || attribution.kind === 'stale-tree-debris') {
      log(
        `[main-dirty] dispatch-time: integration branch ${integrationBranch} dirt attributed to '${attribution.kind}' for task ${task.id}; proceeding to dispatch (the merge path resets stale-tree debris)`,
      )
      return { parked: false }
    }

    // attribution.kind === 'operator-dirt' — including its own fail-safe
    // default when lastSyncedSha is unknown/unattributable. Before trusting
    // that verdict, run the structural rewind check: it catches the shape
    // attributeIntegrationDirt cannot (a checkout multiple merges behind
    // HEAD, or a stale/unset lastSyncedSha) by comparing against every
    // recent ancestor of HEAD instead of just lastSyncedSha..headSha.
    const rewoundAncestor = await findRewoundAncestorSha({
      repoRoot,
      headSha,
      traceCtx: { taskId: task.id, originId, phase: 'setup', store: traceStore },
    })
    if (rewoundAncestor !== null) {
      log(
        `[main-dirty] dispatch-time: integration branch ${integrationBranch} working tree is byte-identical to ancestor ${rewoundAncestor} of HEAD for task ${task.id}; classifying as a rewind (stale-tree debris), proceeding to dispatch without a committer`,
      )
      return { parked: false }
    }

    const levers = resolveControlLevers()
    if (!isOperatorAutoCommitDisabled(levers)) {
      log(
        `[main-dirty] dispatch-time: integration branch ${integrationBranch} has operator dirt for task ${task.id}, but the operatorAutoCommit lever is on; proceeding to dispatch (the merge step will auto-commit it)`,
      )
      return { parked: false }
    }
    // Lever off: fall through to the existing block-and-raise path below.
  }
  // headSha resolution failure is unattributable — fail safe by falling
  // through to the existing block-and-raise path, same as an off lever.

  const recipe = recipeCatalog.get(MAIN_COMMITER_RECIPE)
  if (!recipe) {
    // Recipe missing means the binary was shipped without its built-in
    // file (or a broken override stripped it). With the legacy
    // `setup:preflight/dirty-main` backstop retired (slice K), there is
    // nothing to fall back to inside the workflow — the dispatch must
    // proceed and the verify-time dirty-main check (also wired to
    // `main-commiter`) will park the task. Surface a warn-level log so
    // an operator notices the broken catalog.
    log(
      `[main-dirty] dispatch-time: integration branch ${integrationBranch} is dirty for task ${task.id}, but recipe '${MAIN_COMMITER_RECIPE}' is missing from the catalog; proceeding to dispatch (verify-time check still applies)`,
    )
    return { parked: false }
  }

  const detection: IntegrationBranchDirtyResult = {
    dirty: true,
    statusOutput: classifyResult.statusOutput,
  }
  const resolution = await spawnOrAttachMainCommitter({
    sourceTaskId: task.id,
    detection,
    integrationBranch,
    dispatchPhase: 'dispatch',
    recipePrompt: recipe.prompt,
    sourceOriginId: originId,
  })
  log(
    `[main-dirty] dispatch-time: task ${task.id} parked blocked on main-commiter ${resolution.fixTaskId} (${
      resolution.spawned
        ? resolution.reapedZombieCommitterId
          ? `spawned fresh, replacing zombie committer ${resolution.reapedZombieCommitterId}`
          : 'spawned fresh'
        : `attached to live committer in status=${resolution.attachedToStatus}`
    })`,
  )
  return { parked: true, fixTaskId: resolution.fixTaskId, spawned: resolution.spawned }
}
