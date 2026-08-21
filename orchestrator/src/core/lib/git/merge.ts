import { resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { getStateDir } from '../../context'
import { parseClaudeStreamLine, type AgentEvent } from '../claude-stream'
import {
  exec,
  execProbe,
  resolveGitBin,
  repoRoot,
  moduleDir,
  type TraceCtx,
} from './internal'
import { acquireLock } from './lock'
import { captureCheckpoint, discardWorkingTreeChanges } from './checkpoint'
import {
  runSubprocessStreaming,
  resolveClaudeBin,
  claudeStreamArgs,
  buildWorkerEnv,
  extractSessionIdFromConversation,
} from '../../ports/executor/executor-helpers'
import type { RunSubprocessResult } from '../../ports/executor/types'

export type MergeTargetStatus =
  | { kind: 'clean' }
  // The task branch has diverged from / fallen behind integration, so a
  // bare `--ff-only` would fail. This is NOT a blocking failure: mergeBranch
  // Step 1 rebases the task branch onto integration (escalating to the
  // vcs-supervisor on conflict) before the ff. Preflight must let these
  // through, not park the task — conflating this with `dirty` is what made
  // every lapped branch dead-loop the retry budget.
  | { kind: 'needs-rebase'; targetPath: string; statusOutput: string }
  | { kind: 'dirty'; targetPath: string; statusOutput: string }
  | { kind: 'error'; error: Error }

export interface CheckMergeTargetArgs {
  integrationBranch: string
  taskBranch: string
  /** Optional trace context. Default phase is `merge` when omitted. */
  traceCtx?: TraceCtx
}

// Classifies the merge target ahead of mergeBranch:
//   - 'error'        : a ref does not resolve / git failed unexpectedly.
//   - 'needs-rebase' : integrationBranch is NOT an ancestor of taskBranch
//                      (diverged or behind). Recoverable — mergeBranch
//                      Step 1 rebases before the ff. Preflight proceeds.
//   - 'dirty'        : a tracked, uncommitted change in the merge target
//                      sits on a path the ff would update. Blocking.
//   - 'clean'        : ff is feasible and the target is pristine.
// Untracked files are deliberately ignored: an untracked .idea/ or editor
// scratch file in the merge target cannot block `git merge --ff-only`.
export const checkMergeTargetStatus = async (
  args: CheckMergeTargetArgs,
): Promise<MergeTargetStatus> => {
  const targetPath = repoRoot()
  const { integrationBranch, taskBranch } = args
  const mergeCtx: TraceCtx | undefined = args.traceCtx
    ? { ...args.traceCtx, phase: args.traceCtx.phase ?? 'merge' }
    : undefined
  try {
    await exec(
      resolveGitBin(),
      ['rev-parse', '--verify', `${integrationBranch}^{commit}`],
      { cwd: targetPath },
      mergeCtx,
    )
    await exec(
      resolveGitBin(),
      ['rev-parse', '--verify', `${taskBranch}^{commit}`],
      { cwd: targetPath },
      mergeCtx,
    )

    // `git merge-base --is-ancestor` exits 0 when ancestor, 1 when not, other
    // codes on usage/IO errors. Use execProbe so non-zero exits are warn-level
    // probes in the trace rather than spurious errors.
    const ancestry = await execProbe(
      resolveGitBin(),
      ['merge-base', '--is-ancestor', integrationBranch, taskBranch],
      { cwd: targetPath },
      mergeCtx,
    )
    if (ancestry.exitCode !== 0) {
      if (ancestry.exitCode === 1) {
        // Diverged or behind: a rebase candidate, NOT a dirty-target failure.
        // mergeBranch Step 1 rebases onto integration before the ff merge.
        return {
          kind: 'needs-rebase',
          targetPath,
          statusOutput: `task branch ${taskBranch} is not a fast-forward of ${integrationBranch} (diverged or behind)`,
        }
      }
      return {
        kind: 'error',
        error: new Error(
          `git merge-base --is-ancestor failed (code=${ancestry.exitCode}): ${ancestry.stderr.trim()}`,
        ),
      }
    }

    // Check for any tracked uncommitted changes on the integration branch.
    // We report dirty for ALL tracked edits — not just those overlapping the
    // fast-forward path — so an operator who edited a file that is not in the
    // task diff is not silently allowed through. Untracked files are ignored
    // (they cannot block an ff merge).
    const status = await exec(
      resolveGitBin(),
      ['status', '--porcelain', '--untracked-files=no'],
      { cwd: targetPath },
      mergeCtx,
    )
    if (status.stdout.length === 0) return { kind: 'clean' }
    return {
      kind: 'dirty',
      targetPath,
      statusOutput: `tracked operator changes in the integration checkout:\n${status.stdout}`,
    }
    // TODO(merge_target_missing): also surface a 'missing' kind when the
    // merge target branch has been deleted/renamed; for now any unexpected
    // git failure is reported as 'error'.
  } catch (error: unknown) {
    return {
      kind: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

// ---------------------------------------------------------------------------
// ADR-0100 shared contract — "Merges are rebase→verify→ff CAS loops; main stays
// a live checkout".
//
// Everything between this banner and the {@link MergeArgs} declaration is the
// vocabulary the ADR-0100 rewrite is expressed in. It is declared here, once,
// so each of the seven behavioural slices can branch off a `main` that already
// agrees on the names and shapes:
//
//   1. Record lastSyncedSha for the integration checkout
//        → {@link LAST_SYNCED_REF_PREFIX}, {@link lastSyncedRef},
//          {@link MergeResult.lastSyncedSha}
//   2. Reset stale-tree debris instead of checkpointing it
//        → `attributeIntegrationDirt` (already landed in
//          `./stale-tree-attribution`) consumes {@link lastSyncedRef}'s value
//   3. Run full verify on the rebased tree, outside the merge lock
//        → {@link MergeArgs.onVerifyRebasedTree}, {@link MergeGateOutcome},
//          {@link MergeResult.rebasedVerifyOutput}
//   4. CAS fast-forward under the lock with redo on base mismatch
//        → {@link MergeResult.retriesAttempted} (the ADR's "redo"),
//          {@link MergeFailureReason}
//   5. Delete the Step 3 re-sync / dirty-classification / checkpoint machinery
//        → retires `'merge-left-dirty-tree'` from {@link MergeFailureReason}
//   6. Auto-commit genuine operator dirt as a wip(operator) commit + Notice
//        → {@link MergeArgs.autoCommitOperatorDirt},
//          {@link MergeArgs.onOperatorAutoCommit},
//          {@link OperatorAutoCommitInfo}, {@link operatorWipCommitMessage}
//   7. Typecheck probe on main after an operator auto-commit
//        → {@link MergeArgs.onProbeIntegrationAfterAutoCommit},
//          {@link MergeGateOutcome}
//
// This slice declares the contract only. The behaviour behind each hook lands
// in the consumer slice named above it.
// ---------------------------------------------------------------------------

/**
 * Ref namespace under which the merge step records the SHA it last synced the
 * integration checkout's *working tree* to.
 *
 * A git ref (rather than a file under `.mars/`) because it is written with the
 * same atomic `update-ref` CAS the merge itself uses, lives in the repo the
 * checkout belongs to, and survives a daemon restart or crash. It mirrors
 * `CHECKPOINT_REF_PREFIX` in `./checkpoint`, including its key sanitisation.
 *
 * This value is what makes `attributeIntegrationDirt`'s stale-tree test
 * decidable: without a recorded last-synced SHA the predicate has no basis for
 * the inverse-diff comparison and fails safe to `operator-dirt` (ADR-0100,
 * "The merge step records the sha it last synced the tree to precisely so this
 * test is decidable").
 */
export const LAST_SYNCED_REF_PREFIX = 'refs/mars/last-synced'

/**
 * The {@link LAST_SYNCED_REF_PREFIX} ref for one integration branch. Branch
 * names may legally contain `/`, which would nest the ref and collide with a
 * sibling; sanitise exactly as `./checkpoint` sanitises its key so
 * `refs/mars/last-synced/<branch>` is always a single, flat ref level.
 */
export const lastSyncedRef = (integrationBranch: string): string =>
  `${LAST_SYNCED_REF_PREFIX}/${integrationBranch.replace(/[^A-Za-z0-9._-]/g, '-')}`

/**
 * The exact commit subject used when genuine operator dirt on the integration
 * checkout is auto-committed to unblock a merge (ADR-0100). Operator-visible
 * and therefore pinned: the operator greps for it, the Notice quotes it, and
 * `mars` tooling recognises an auto-commit by it.
 */
export const operatorWipCommitMessage = (taskId: string): string =>
  `wip(operator): auto-committed to unblock merge of ${taskId}`

/**
 * Outcome of a caller-supplied gate that runs a command on a tree and either
 * passes or reports why it did not. Shared by the two ADR-0100 gates so they
 * cannot drift apart:
 *
 *  - {@link MergeArgs.onVerifyRebasedTree} — the full verify of the rebased
 *    task tree, run OUTSIDE the merge lock (slice 3).
 *  - {@link MergeArgs.onProbeIntegrationAfterAutoCommit} — the cheap typecheck
 *    probe of `main` after an operator auto-commit (slice 7).
 */
export type MergeGateOutcome =
  | { passed: true }
  | { passed: false; output: string }

/** Payload delivered to {@link MergeArgs.onOperatorAutoCommit}. */
export interface OperatorAutoCommitInfo {
  /** SHA of the `wip(operator)` commit just created on the integration branch. */
  commitSha: string
  /** Tracked paths swept into that commit, in `git status --porcelain` order. */
  files: string[]
  /**
   * Outcome of the post-auto-commit typecheck probe (slice 7), or `null` when
   * no {@link MergeArgs.onProbeIntegrationAfterAutoCommit} was supplied. The
   * merge proceeds either way — a failing probe raises an Alert, it does not
   * block the merge.
   */
  probe: MergeGateOutcome | null
}

/**
 * Machine-readable reason for a `merged: false` {@link MergeResult} that is
 * neither an abort nor an integration-gate failure.
 *
 * - `'merge-left-dirty-tree'` — the post-merge working-tree assertion found
 *   the integration checkout dirty. **Retired by slice 5**: once the Step 3
 *   re-sync / dirty-classification / checkpoint machinery is deleted, dirt is
 *   attributed (stale-tree debris → reset, operator dirt → auto-commit) rather
 *   than reported as a merge failure. Kept in the union until that slice lands
 *   so the deletion is a single, legible change.
 * - `'rebased-verify-failed'` — {@link MergeArgs.onVerifyRebasedTree} rejected
 *   the rebased tree, so nothing was fast-forwarded. `main` is untouched and
 *   the failure belongs to the task branch, not to the merge target.
 */
export type MergeFailureReason =
  | 'merge-left-dirty-tree'
  | 'rebased-verify-failed'

/**
 * Interval (ms) at which {@link MergeArgs.onHeartbeat} fires while the merge
 * lock is held.
 */
const MERGE_HEARTBEAT_INTERVAL_MS = 30_000

/** Payload delivered to {@link MergeArgs.onHeartbeat} on each periodic tick. */
interface MergeHeartbeatInfo {
  /** Wall-clock milliseconds elapsed since the merge lock was acquired. */
  elapsedMs: number
  /**
   * The merge sub-phase currently in flight — the same label set emitted by
   * {@link MergeArgs.onPhase} (`acquire-lock`, `rebase`, `vega`,
   * `fast-forward`, `integration-gate`, etc.).
   */
  phase: string
  /** 1-indexed rebase+fast-forward attempt number within this merge invocation. */
  attempt: number
}

export interface MergeArgs {
  branch: string
  worktreePath: string
  integrationBranch: string
  lockTimeoutMs: number
  /**
   * Caller-supplied cancellation signal. When it aborts, the in-flight git
   * child is killed, best-effort rebase/merge cleanup runs, the merge lock is
   * released, and `mergeBranch` rejects with a {@link MergeAbortedError} whose
   * `reason` is `'external'`. Optional — omit to rely solely on the watchdog.
   */
  signal?: AbortSignal
  /**
   * Watchdog budget in milliseconds. An internal timer aborts the merge after
   * this elapsed wall-clock time, rejecting with a {@link MergeAbortedError}
   * whose `reason` is `'watchdog'`. Defaults to 5 minutes.
   */
  watchdogMs?: number
  /** Optional trace context. Default phase is `merge` when omitted. */
  traceCtx?: TraceCtx
  onSupervisorEvent?: (event: AgentEvent) => void | Promise<void>
  /**
   * Fired exactly once, the moment the deterministic fast-forward path fails
   * and Vega (the vcs-supervisor) is about to be spawned to reconcile
   * conflicts. A clean fast-forward never invokes this. Callers use it to flip
   * the task from the idempotent `merging` status to `vega-reconciling`, so the
   * operator can tell a safe-to-resume merge apart from one hosting a live
   * Claude session.
   */
  onVegaStart?: () => void | Promise<void>
  /**
   * TEST-ONLY seam: awaited immediately before the CAS `git update-ref` in
   * each merge iteration. Lets tests deterministically inject a concurrent
   * integration advance between the ancestry check and the fast-forward.
   * Never set this in production code.
   */
  onBeforeFastForward?: () => void | Promise<void>
  /**
   * Called inside the merge lock after the fast-forward AND the working-tree
   * resync (Step 3), but BEFORE the lock is released. Receives the pre-merge
   * (`finalIntegrationSha`) and post-merge (`finalTaskSha`) integration SHAs
   * so the caller can identify the set of changed files.
   *
   * If this callback throws, `mergeBranch` reverts the fast-forward (rolls
   * `refs/heads/<integrationBranch>` back to `finalIntegrationSha` via a
   * CAS update-ref, and resets the working tree if Step 3 applied a
   * `git reset --hard`) and returns
   * `{ merged: false, aborted: false, integrationGateFailed: true, integrationGateOutput: <error.message> }`.
   *
   * Used by the merge primitive to run tier:'integration' verify gates under
   * the merge lock, guaranteeing that at most one full suite runs at a time.
   * Repos whose recipe defines no integration-tier gates pass a callback that
   * returns immediately — zero added latency.
   */
  onAfterFastForward?: (info: {
    finalTaskSha: string
    finalIntegrationSha: string
  }) => Promise<void>
  /**
   * Best-effort callback fired at key sub-phase transitions within the merge:
   * `acquire-lock`, `rebase`, `vega`, `fast-forward`, `integration-gate`.
   * A reporting failure (throw or rejected promise) is silently swallowed —
   * it must never abort or slow a merge.
   */
  onPhase?: (phase: string) => void | Promise<void>
  /**
   * Fired every {@link MERGE_HEARTBEAT_INTERVAL_MS} while the merge lock is
   * held. Use to emit keep-alive events so the UI and operator tooling know
   * the merge is still in progress during long vcs-supervisor sessions.
   * A reporting failure (throw or rejected promise) is silently swallowed —
   * it must never abort or slow a merge.
   */
  onHeartbeat?: (info: MergeHeartbeatInfo) => void | Promise<void>
  /**
   * ADR-0100 step 2 (slice 3): run the FULL verify suite against the rebased
   * task tree, in the task's own worktree, **outside** the merge lock.
   *
   * What lands on `main` is then byte-for-byte the tree this callback passed,
   * so the fast-forward is safe by construction and the semantic-conflict
   * window — two individually-green branches composing into a broken `main` —
   * is closed. It runs per attempt: a CAS redo re-rebases and therefore
   * re-verifies, which is the cost the ADR explicitly accepts.
   *
   * Returning `{ passed: false }` ends the merge with `merged: false` and
   * `reason: 'rebased-verify-failed'`; `main` is left untouched.
   *
   * Omit to skip the gate entirely (the pre-ADR-0100 behaviour).
   */
  onVerifyRebasedTree?: (info: {
    /** The integration tip the task branch was just rebased onto. */
    baseSha: string
    /** The rebased task-branch tip whose tree is under test. */
    taskSha: string
    /** 1-indexed rebase+fast-forward attempt number. */
    attempt: number
  }) => Promise<MergeGateOutcome>
  /**
   * ADR-0100 operator-dirt automation lever (slice 6). When `true` (the
   * default), genuine operator dirt on the integration checkout — dirt that
   * survives the `attributeIntegrationDirt` stale-tree test — is swept into a
   * {@link operatorWipCommitMessage} commit so the merge can proceed.
   *
   * When `false`, the behaviour degrades to raising an Alert and parking the
   * queue. This is the flag {@link onOperatorAutoCommit}'s Notice offers to
   * flip; the caller resolves it from operator state and passes the answer in.
   */
  autoCommitOperatorDirt?: boolean
  /**
   * Fired once, after a `wip(operator)` commit has been created on the
   * integration branch (slice 6). The caller speaks the Notice that tells the
   * operator it happened and offers to disable the automation, and raises an
   * Alert when `info.probe` reports a failure (slice 7).
   *
   * Best-effort: a throw is swallowed. The commit has already landed and the
   * merge must not be undone by a reporting failure.
   */
  onOperatorAutoCommit?: (info: OperatorAutoCommitInfo) => void | Promise<void>
  /**
   * ADR-0100 slice 7: a cheap gate (typecheck) probing `main` immediately
   * after an operator auto-commit, bounding detection latency for a broken
   * auto-committed baseline to seconds.
   *
   * The merge proceeds regardless of the outcome — the result is reported
   * through {@link OperatorAutoCommitInfo.probe} so the caller can raise an
   * Alert and the operator can amend before anything builds on it. Omit to
   * skip the probe.
   */
  onProbeIntegrationAfterAutoCommit?: (info: {
    /** SHA of the `wip(operator)` commit to probe. */
    commitSha: string
  }) => Promise<MergeGateOutcome>
}

export interface MergeResult {
  merged: boolean
  conflictResolved: boolean
  aborted: boolean
  output: string
  supervisorConversation: AgentEvent[]
  /**
   * Claude session id from the vcs-supervisor run, or null when no supervisor
   * was invoked (fast-forward merge) or when the supervisor conversation
   * contained no session_id event.
   */
  vegaSessionId: string | null
  /**
   * Number of times the rebase+fast-forward was re-attempted due to a detected
   * concurrent integration advance; 0 on first-try success or non-retryable abort.
   */
  retriesAttempted: number
  /**
   * True when the caller-supplied {@link MergeArgs.onAfterFastForward} hook
   * threw (integration-tier gates failed). The fast-forward has been reverted
   * and the integration branch is clean at the pre-merge SHA.
   * `integrationGateOutput` carries the failure details.
   */
  integrationGateFailed?: boolean
  /**
   * Failure output from the integration-tier gates when `integrationGateFailed`
   * is true. Used by the merge primitive to seed the recovery Chore.
   */
  integrationGateOutput?: string
  /**
   * True when the vcs-supervisor (Vega) session was killed by the per-step
   * wall-clock timeout ({@link VCS_SUPERVISOR_TIMEOUT_MS}). In this case
   * `aborted` is also true and any in-progress rebase has been aborted, and
   * the merge lock has already been released.
   *
   * The merge primitive maps this to the `merge:vega-timeout` failure signature
   * so the action queue shows a recognisable, actionable item — prompting the
   * operator to resolve the conflict manually or restart the task — distinct
   * both from a generic abort and from a Vega run that actively reconciled but
   * failed the post-supervisor tree checks.
   */
  vegaTimedOut?: boolean
  /**
   * Machine-readable reason for a `merged: false` outcome that is not an abort
   * or integration-gate failure. See {@link MergeFailureReason} for the closed
   * vocabulary and what each member means.
   */
  reason?: MergeFailureReason
  /**
   * Verify output from {@link MergeArgs.onVerifyRebasedTree} when it rejected
   * the rebased tree. Set exactly when `reason === 'rebased-verify-failed'`,
   * and used to seed the recovery task the way `integrationGateOutput` is.
   */
  rebasedVerifyOutput?: string
  /**
   * The SHA the integration checkout's working tree was synced to by this
   * merge, mirrored from {@link lastSyncedRef}. Set on a successful
   * fast-forward that also re-synced the checkout; absent when the merge did
   * not touch the tree (aborted, no-op, or the primary checkout was not on the
   * integration branch).
   *
   * Callers must treat the ref as the source of truth — this field is the
   * convenience mirror for the merge that just ran, not a general reader.
   */
  lastSyncedSha?: string
  /**
   * SHA of the `wip(operator)` commit created to sweep genuine operator dirt
   * off the integration checkout, or absent when no auto-commit happened
   * (clean tree, stale-tree debris that was simply reset, or
   * {@link MergeArgs.autoCommitOperatorDirt} disabled).
   */
  operatorAutoCommitSha?: string
  /**
   * The integration-branch SHA just before the fast-forward (i.e. the old tip
   * of `integrationBranch`). Set only on a successful fast-forward merge so the
   * caller can reconstruct the merged diff via `git diff mergePreSha mergePostSha`.
   * Absent when the merge was aborted, was a no-op, or the integration gate
   * reverted the fast-forward.
   */
  mergePreSha?: string
  /**
   * The task-branch SHA that was fast-forwarded into `integrationBranch`
   * (i.e. the new tip after the fast-forward). Set in the same conditions as
   * `mergePreSha`.
   */
  mergePostSha?: string
}

let cachedSupervisorSpec: string | null = null

export const stripFrontmatter = (text: string): string => {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return text
  const afterOpening = text.indexOf('\n') + 1
  const closingMatch = text.slice(afterOpening).match(/^---(\r?\n|$)/m)
  if (!closingMatch || closingMatch.index === undefined) return text
  const closingEnd = afterOpening + closingMatch.index + closingMatch[0].length
  return text.slice(closingEnd).replace(/^\r?\n+/, '')
}

const loadSupervisorSpec = async (): Promise<string> => {
  if (cachedSupervisorSpec) return cachedSupervisorSpec
  // This module lives at `core/lib/git/merge.ts`; the original `git.ts` lived
  // one level up at `core/lib/git.ts`, so each candidate gains one `../` to
  // resolve to the same on-disk locations (`core/public/prompts/...` and the
  // `core/lib/prompts/...` bundled fallback) as before the split.
  const candidates = [
    resolve(moduleDir(), '../../public/prompts/vcs-supervisor.md'),
    resolve(moduleDir(), '../prompts/vcs-supervisor.md'),
  ]
  for (const candidate of candidates) {
    try {
      cachedSupervisorSpec = await readFile(candidate, 'utf8')
      return cachedSupervisorSpec
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(
    `vcs-supervisor.md not found; checked: ${candidates.join(', ')}`,
  )
}

const buildSupervisorPrompt = async (
  branch: string,
  integrationBranch: string,
): Promise<string> => {
  const spec = stripFrontmatter(await loadSupervisorSpec())
  return `${spec}

# Dispatch

Mode: rebase
Source: ${branch}
Target: ${integrationBranch}

A \`git rebase ${integrationBranch}\` of ${branch} just conflicted in this worktree. The rebase is in progress (\`.git/rebase-merge/\` or \`.git/rebase-apply/\` exists). Your cwd IS the worktree — do not \`cd\` elsewhere.

Resolve every conflict per your protocol — read both sides, reconcile intent, never blindly pick ours/theirs. After staging each step, use \`git rebase --continue\` (NOT \`git commit\`). Repeat until the rebase finishes.

End with the Completion Report block exactly as specified above.`
}

export interface InvokeSupervisorResult extends RunSubprocessResult {
  conversation: AgentEvent[]
}

/**
 * Wall-clock budget for one vcs-supervisor session. Shared by every caller so
 * the two dispatch sites (the merge step's rebase, and the setup step's
 * bring-the-worktree-current rebase) cannot drift apart.
 *
 * Default: 10 minutes. Override with `MARS_VCS_SUPERVISOR_TIMEOUT_MS` (ms).
 * A shorter value makes a hung session detectable faster; set it higher when
 * legitimate conflict resolutions routinely exceed the default.
 */
export const VCS_SUPERVISOR_TIMEOUT_MS: number = Number(
  process.env.MARS_VCS_SUPERVISOR_TIMEOUT_MS ?? 10 * 60 * 1000,
)

/**
 * Spawn Vega against a rebase that is CURRENTLY IN PROGRESS in `cwd`.
 *
 * The prompt asserts "a `git rebase <target>` of <source> just conflicted in
 * this worktree; the rebase is in progress" — so the caller must NOT have run
 * `git rebase --abort` first, and must have confirmed the on-disk rebase state
 * exists. Dispatching against a false premise produces a refusal that matches
 * no classifier rule (see the guard at the merge step's conflict branch).
 *
 * Exported because the setup step reuses this verbatim: a conflicted rebase is
 * the same problem wherever it happens, and the prompt is written about the
 * git state, not about the merge phase.
 *
 * When `timeoutMs` elapses the subprocess is killed with SIGKILL and the
 * function returns `{ exitCode: 124, … }` — the sentinel used by callers to
 * distinguish a timed-out session from a clean zero exit.
 */
export const invokeVcsSupervisor = async (
  branch: string,
  integrationBranch: string,
  cwd: string,
  timeoutMs: number,
  onEvent?: (event: AgentEvent) => void | Promise<void>,
): Promise<InvokeSupervisorResult> => {
  const prompt = await buildSupervisorPrompt(branch, integrationBranch)
  const conversation: AgentEvent[] = []
  // AbortController used to kill the subprocess when the timeout fires.
  // Without this, the old Promise.race approach resolved the caller's promise
  // but left the subprocess running in the background — it could still be
  // writing to disk (conflict markers, staged hunks) while mergeBranch ran
  // `git rebase --abort`, causing a race and corrupting worktree state.
  let timedOut = false
  const ac = new AbortController()
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, timeoutMs)
  try {
    const result = await runSubprocessStreaming(
      resolveClaudeBin(),
      claudeStreamArgs(prompt),
      cwd,
      async ({ stream, line }) => {
        if (stream !== 'stdout') return
        const event = parseClaudeStreamLine(line)
        if (!event) return
        conversation.push(event)
        if (onEvent) await onEvent(event)
      },
      ac.signal,
      buildWorkerEnv(),
    )
    // When the abort was triggered by our own timer, replace the subprocess's
    // (SIGKILL'd) exit code with the conventional timeout sentinel 124 so
    // callers don't have to inspect the abort reason separately.
    if (timedOut) {
      return {
        exitCode: 124,
        stdout: '',
        stderr: `vcs-supervisor timed out after ${timeoutMs}ms`,
        conversation,
      }
    }
    return { ...result, conversation }
  } finally {
    clearTimeout(timer)
  }
}

// Portable directory check. Replaces a prior shell-out to `test -d <path>`,
// which is POSIX-only. `fs.stat(p).isDirectory()` works identically across
// darwin/linux/windows and returns false (rather than throwing) when the
// path is missing.
const isDirectory = async (p: string): Promise<boolean> => {
  try {
    const s = await stat(p)
    return s.isDirectory()
  } catch {
    return false
  }
}

const isRebaseInProgress = async (
  cwd: string,
  traceCtx?: TraceCtx,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['rev-parse', '--git-path', 'rebase-merge'],
      { cwd, signal },
      traceCtx,
    )
    const mergePath = stdout.trim()
    const { stdout: applyStdout } = await exec(
      resolveGitBin(),
      ['rev-parse', '--git-path', 'rebase-apply'],
      { cwd, signal },
      traceCtx,
    )
    const applyPath = applyStdout.trim()
    const checks = await Promise.all([
      isDirectory(mergePath),
      isDirectory(applyPath),
    ])
    return checks.some(Boolean)
  } catch {
    return false
  }
}

// This is a merge-PRIMITIVE retry budget (inside one merge attempt under the
// held .merge.lock), NOT a task-layer retry. It does not violate the ADR-0040
// / CLAUDE.md "exactly one recovery attempt per origin failure" task-layer
// invariant: that invariant governs how many recovery tasks the orchestrator
// may spawn; this loop retries the rebase+fast-forward within a single
// lock-held invocation and only falls through to aborted:true (which triggers
// a recovery task) after the bounded budget is exhausted. NOT env-overridable
// — matches the repo's no-retry-knob ethos.
const MAX_MERGE_ATTEMPTS = 3 // 1 initial attempt + 2 retries

/**
 * Wall-clock headroom for the git work that surrounds one vcs-supervisor
 * session inside a single merge (rebase, post-supervisor verification, the
 * fast-forward ref update, and the Step 3 re-sync). Added on top of
 * {@link VCS_SUPERVISOR_TIMEOUT_MS} so the watchdog cannot expire mid-session.
 */
const MERGE_GIT_BUDGET_MS = 5 * 60 * 1000

/**
 * Default watchdog budget for one {@link mergeBranch} call holding the
 * `.merge.lock`. Sized to comfortably contain a full vcs-supervisor session
 * plus the git work around it — enforced by the
 * `merge-watchdog-budget.test.ts` invariants.
 */
export const DEFAULT_WATCHDOG_MS = VCS_SUPERVISOR_TIMEOUT_MS + MERGE_GIT_BUDGET_MS

/**
 * Hard wall-clock ceiling (milliseconds) for the merge STEP, measured at the
 * `enqueueMergeJobAndAwait` call site in the merge primitive. Defaults to
 * {@link DEFAULT_WATCHDOG_MS} + 2 min grace so the ceiling fires only when
 * the merge job has clearly stalled past its own internal watchdog.
 *
 * Override with `MARS_MERGE_HARD_TIMEOUT_MS`.
 */
export const MERGE_HARD_TIMEOUT_MS = Number(
  process.env.MARS_MERGE_HARD_TIMEOUT_MS ?? DEFAULT_WATCHDOG_MS + 2 * 60 * 1000,
)

/**
 * Thrown when the merge step's hard wall-clock ceiling
 * ({@link MERGE_HARD_TIMEOUT_MS}) fires before `enqueueMergeJobAndAwait`
 * returns. Caught by the merge primitive which converts it to a
 * {@link WorkflowTerminalError} with failure-signature prefix
 * `merge:hard-timeout`.
 */
export class MergeHardTimeoutError extends Error {
  readonly phase: string

  constructor(phase: string) {
    super(`merge hard timeout in ${phase}`)
    this.name = 'MergeHardTimeoutError'
    this.phase = phase
  }
}

/**
 * Short, self-contained timeout for the abort-cleanup git calls. These run
 * AFTER the merge has already been aborted, so they must never inherit the
 * (already-aborted) merge signal — they get their own bound so a wedged git
 * cannot hang the cleanup path.
 */
const ABORT_CLEANUP_TIMEOUT_MS = 10_000

/**
 * Formats a millisecond duration into a human-readable string.
 * Tiers: <1s → "Nms", <60s → "N.Ns", <60m → "Nm Ns" (drops "Ns" when s===0),
 * else "Nh Nm" (drops "Nm" when m===0).
 */
function formatMsDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

/**
 * Thrown by {@link mergeBranch} when the merge is cancelled — either by the
 * internal watchdog timer (`reason: 'watchdog'`) or by the caller's
 * `AbortSignal` (`reason: 'external'`). `elapsedMs` is the wall-clock time from
 * lock-acquisition attempt to abort; `lastStep` names the merge phase in flight
 * when the abort landed.
 */
export class MergeAbortedError extends Error {
  readonly reason: 'watchdog' | 'external'
  readonly elapsedMs: number
  readonly lastStep: string

  constructor(reason: 'watchdog' | 'external', elapsedMs: number, lastStep: string) {
    super(
      `mergeBranch aborted (${reason}) after ${formatMsDuration(elapsedMs)} during step '${lastStep}'`,
    )
    this.name = 'MergeAbortedError'
    this.reason = reason
    this.elapsedMs = elapsedMs
    this.lastStep = lastStep
  }
}

/**
 * Best-effort teardown of any in-progress rebase/merge left behind by an
 * aborted merge. Both calls are bounded by their own short timeout (NOT the
 * already-aborted merge signal) and swallow every error — a wedged worktree
 * must never keep the abort path from completing.
 */
const bestEffortAbortCleanup = async (
  worktreePath: string,
  traceCtx?: TraceCtx,
): Promise<void> => {
  await execProbe(
    resolveGitBin(),
    ['rebase', '--abort'],
    { cwd: worktreePath, timeout: ABORT_CLEANUP_TIMEOUT_MS },
    traceCtx,
  ).catch(() => {})
  await execProbe(
    resolveGitBin(),
    ['merge', '--abort'],
    { cwd: worktreePath, timeout: ABORT_CLEANUP_TIMEOUT_MS },
    traceCtx,
  ).catch(() => {})
}

export const mergeBranch = async ({
  branch,
  worktreePath,
  integrationBranch,
  lockTimeoutMs,
  signal,
  watchdogMs = DEFAULT_WATCHDOG_MS,
  onSupervisorEvent,
  onVegaStart,
  onBeforeFastForward,
  onAfterFastForward,
  onPhase,
  onHeartbeat,
  traceCtx,
}: MergeArgs): Promise<MergeResult> => {
  const mergeCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'merge' }
    : undefined

  // Watchdog: an internal timer aborts the merge after `watchdogMs`, combined
  // with the caller's signal (if any) via AbortSignal.any. Every git spawn
  // below forwards `combinedSignal`, so a wedged primitive is killed rather
  // than hanging the merge lock forever.
  const startedAt = Date.now()
  let lastStep = 'init'
  // Tracks the current rebase+fast-forward attempt number; updated at the top
  // of each loop iteration and read by the heartbeat closure.
  let currentAttempt = 1
  const watchdogController = new AbortController()
  const watchdogTimer = setTimeout(() => {
    watchdogController.abort()
  }, watchdogMs)
  const combinedSignal: AbortSignal = signal
    ? AbortSignal.any([watchdogController.signal, signal])
    : watchdogController.signal

  // Best-effort phase reporter: fires onPhase and swallows all errors so a
  // reporting failure can never abort or slow a merge.
  const firePhase = (phase: string): void => {
    if (!onPhase) return
    try {
      const result = onPhase(phase)
      if (result instanceof Promise) result.catch(() => {})
    } catch {
      // intentionally swallowed — reporting must never abort a merge
    }
  }

  // Thin wrappers that thread `combinedSignal` (and the trace ctx) into every
  // git spawn without repeating the boilerplate at each call site.
  const gexec = (
    args: readonly string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string }> =>
    exec(resolveGitBin(), args, { cwd, signal: combinedSignal }, mergeCtx)
  const gprobe = (
    args: readonly string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    execProbe(resolveGitBin(), args, { cwd, signal: combinedSignal }, mergeCtx)

  try {
    lastStep = 'acquire-lock'
    firePhase('acquire-lock')
    // Belt-and-suspenders single-daemon guard: the merge queue's
    // single-consumer loop already serialises merges, so this file lock is
    // only a safety net against a second daemon process accidentally running
    // alongside the first. The caller (merge-worker) passes lockTimeoutMs=30s,
    // which is sufficient for a transient conflict without blocking long.
    const release = await acquireLock(
      resolve(getStateDir(), '.merge.lock'),
      lockTimeoutMs,
    )
    // Race the merge body against an abort-signal rejection so the lock is
    // guaranteed to be released even when a callback (e.g. the DB call inside
    // onVegaStart / onAfterFastForward) hangs after a connection reset.
    // Without this race, combinedSignal.aborted becomes true and git
    // subprocesses get killed (via their forwarded signal), but a hanging
    // callback Promise never settles — the inner finally never runs and the
    // lock is held indefinitely.
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        reject(Object.assign(new Error('merge body interrupted by abort signal'), { name: 'AbortError' }))
      }
      if (combinedSignal.aborted) {
        onAbort()
      } else {
        combinedSignal.addEventListener('abort', onAbort, { once: true })
      }
    })

    // Heartbeat timer: fires every MERGE_HEARTBEAT_INTERVAL_MS while the lock
    // is held so callers can emit keep-alive events during long vcs-supervisor
    // sessions. Reads `lastStep` and `currentAttempt` from the enclosing scope,
    // both of which are updated in-place by the merge body as it progresses.
    const lockAcquiredAt = Date.now()
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    if (onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        try {
          const r = onHeartbeat({ elapsedMs: Date.now() - lockAcquiredAt, phase: lastStep, attempt: currentAttempt })
          if (r instanceof Promise) r.catch(() => {})
        } catch {
          // intentionally swallowed — heartbeat must never abort a merge
        }
      }, MERGE_HEARTBEAT_INTERVAL_MS)
    }

    try {
    return await Promise.race([
    (async (): Promise<MergeResult> => {
    let output = ''
    let conflictResolved = false
    let vegaSessionId: string | null = null
    const supervisorConversation: AgentEvent[] = []
    let retriesAttempted = 0

    // finalTaskSha / finalIntegrationSha are written on CAS success inside the
    // loop and consumed by Step 3 outside it. The loop always exits via break
    // (success) or return (abort), so these are always set before Step 3 runs.
    let finalTaskSha = ''
    let finalIntegrationSha = ''

    // Step 0: already-merged short-circuit. When the task branch is fully
    // contained in the integration branch (0 commits ahead), its work is
    // already integrated — there is nothing to rebase or fast-forward. Without
    // this guard the merge dead-loops: preflight classifies the branch
    // `needs-rebase` (integration is AHEAD, so not an ancestor of the task
    // tip), the attempt loop's rebase is a no-op, and the fast-forward-ancestry
    // check keeps failing because integration is not an ancestor of the (behind)
    // task branch — spinning through the retry budget and the vcs-supervisor
    // path without terminating. `git rev-list --count <integration>..<task>`
    // is the robust signal; corroborate with `merge-base --is-ancestor
    // <task> <integration>` (exit 0). Both probes forward `combinedSignal`, so
    // the watchdog still bounds them. Treat as a successful no-op: mirror the
    // clean fast-forward success return, but with no merge work performed and
    // WITHOUT invoking the supervisor or integration-gate callbacks, since
    // nothing changed on integration.
    lastStep = 'already-merged-check'
    const aheadCount = Number.parseInt(
      (
        await gexec(
          ['rev-list', '--count', `${integrationBranch}..${branch}`],
          repoRoot(),
        )
      ).stdout.trim(),
      10,
    )
    const taskIsAncestorOfIntegration =
      (
        await gprobe(
          ['merge-base', '--is-ancestor', branch, integrationBranch],
          repoRoot(),
        )
      ).exitCode === 0
    if (aheadCount === 0 && taskIsAncestorOfIntegration) {
      lastStep = 'already-merged-noop'
      return {
        merged: true,
        conflictResolved: false,
        aborted: false,
        output: `task branch ${branch} is already fully contained in ${integrationBranch} (0 commits ahead); merge is a no-op.`,
        supervisorConversation: [],
        vegaSessionId: null,
        retriesAttempted: 0,
      }
    }

    for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
      // Keep the heartbeat closure up-to-date with the current attempt number.
      currentAttempt = attempt
      // Capture the integration tip BEFORE rebasing so we can later distinguish
      // a retryable forward advance from a non-retryable divergent state when
      // the ancestry check or CAS indicates integration has moved.
      lastStep = 'read-integration-tip'
      const rebaseBaseSha = (
        await gexec(['rev-parse', integrationBranch], repoRoot())
      ).stdout.trim()

      // Step 1: ensure the task branch is up-to-date with integration via rebase
      // inside the worktree. After this, integration can fast-forward to it.
      // The rebase is allowed to fail (conflict path); execProbe keeps the
      // trace severity at warn instead of error for the expected-failure path.
      //
      // On a retry after a concurrent-advance race, re-running `git rebase`
      // replays the already-committed (including any Vega-reconciled) work onto
      // the new integration tip cleanly. Vega is NOT re-invoked unless a
      // genuinely NEW conflict appears in this iteration's rebase.
      // Pre-rebase hygiene check: abort immediately when the task worktree has
      // uncommitted changes BEFORE `git rebase` runs.  A dirty worktree causes
      // `git rebase` to exit non-zero WITHOUT creating a rebase-in-progress
      // state, which used to route to the confusing "rebase-no-in-progress-state"
      // path.  Detecting it here lets the failure-signature classifier route to
      // `rebase-dirty-worktree` (resolution: restart to re-provision the worktree)
      // instead of spawning Vega with a false-premise prompt.  Vega is never
      // the right recovery when there is simply no conflict to reconcile.
      const statusResult = await gprobe(['status', '--porcelain'], worktreePath)
      if (statusResult.stdout.trim().length > 0) {
        return {
          merged: false,
          conflictResolved: false,
          aborted: true,
          output: `worktree dirty before rebase:\n${statusResult.stdout}${output}`,
          supervisorConversation,
          vegaSessionId: null,
          retriesAttempted,
        }
      }

      lastStep = 'rebase'
      firePhase('rebase')
      const rebaseResult = await gprobe(['rebase', integrationBranch], worktreePath)
      output += rebaseResult.stdout + rebaseResult.stderr
      if (rebaseResult.exitCode !== 0) {
        // Guard: only dispatch Vega when git left a real rebase-in-progress
        // state on disk (.git/rebase-merge/ or .git/rebase-apply/). If the
        // rebase exited non-zero WITHOUT creating that state (e.g. uncommitted
        // changes in the worktree blocked the rebase before it could conflict,
        // an invalid upstream ref, or an empty-commit stop), there is nothing
        // for Vega to reconcile. Dispatching it anyway with the hardcoded
        // "rebase is in progress" premise produces a false-premise prompt that
        // Vega correctly refuses, and the refusal's first-line wording matches
        // no classifier rule → merge:vcs-supervisor-aborted/unclassified →
        // first-principles recovery that inherits the same un-reconcilable
        // state and idles until the phantom-task watchdog kills it.
        const rebaseInProgress = await isRebaseInProgress(worktreePath, mergeCtx, combinedSignal)
        if (!rebaseInProgress) {
          return {
            merged: false,
            conflictResolved: false,
            aborted: true,
            output: `rebase produced no in-progress state: nothing to reconcile (rebase exit ${rebaseResult.exitCode})\n${output}`,
            supervisorConversation,
            vegaSessionId: null,
            retriesAttempted,
          }
        }

        // Genuine rebase conflict: transition to the Vega-reconciling phase.
        // Signal the transition out of the idempotent `merging` phase before
        // spawning, so the task shows as `vega-reconciling` for the full
        // duration of the session.
        firePhase('vega')
        await onVegaStart?.()

        const preSha = (
          await gexec(['rev-parse', branch], repoRoot())
        ).stdout.trim()

        lastStep = 'vega-supervisor'
        const sup = await invokeVcsSupervisor(
          branch,
          integrationBranch,
          worktreePath,
          VCS_SUPERVISOR_TIMEOUT_MS,
          onSupervisorEvent,
        )
        supervisorConversation.push(...sup.conversation)
        output += sup.stdout + sup.stderr

        // Detect the per-step timeout before running post-supervisor git checks.
        // exitCode 124 is the sentinel emitted by invokeVcsSupervisor's own
        // internal timeout Promise when the supervisor exceeds
        // VCS_SUPERVISOR_TIMEOUT_MS. The subprocess was killed mid-flight, so we
        // know nothing about the worktree state — the post-supervisor probes
        // below would report meaningless values. Abort the rebase immediately
        // and surface a distinct `vegaTimedOut` result instead.
        if (sup.exitCode === 124) {
          lastStep = 'vega-timeout-abort'
          await gprobe(['rebase', '--abort'], worktreePath).catch(() => {})
          return {
            merged: false,
            conflictResolved: false,
            aborted: true,
            vegaTimedOut: true,
            output: `vcs-supervisor timed out after ${VCS_SUPERVISOR_TIMEOUT_MS}ms; rebase aborted.\n${output}`,
            supervisorConversation,
            vegaSessionId: null,
            retriesAttempted,
          }
        }

        lastStep = 'vega-verify'
        const stillInProgress = await isRebaseInProgress(worktreePath, mergeCtx, combinedSignal)
        const postSha = (
          await gexec(['rev-parse', branch], repoRoot())
        ).stdout.trim()
        const advanced = postSha !== preSha
        const treeClean = await (async () => {
          // `git diff --quiet` is a probe: exit 0 = clean, exit 1 = dirty.
          const a = await gprobe(['diff', '--quiet'], worktreePath)
          if (a.exitCode !== 0) return false
          const b = await gprobe(['diff', '--cached', '--quiet'], worktreePath)
          return b.exitCode === 0
        })()

        if (stillInProgress || !advanced || !treeClean) {
          await gprobe(['rebase', '--abort'], worktreePath).catch(() => {})
          return {
            merged: false,
            conflictResolved: false,
            aborted: true,
            output: `vcs-supervisor outcome rejected by git tree (stillInProgress=${stillInProgress}, advanced=${advanced}, treeClean=${treeClean}); rebase aborted.\n${output}`,
            supervisorConversation,
            vegaSessionId: null,
            retriesAttempted,
          }
        }
        conflictResolved = true
        vegaSessionId = extractSessionIdFromConversation(supervisorConversation)
      }

      // Step 2: fast-forward integration to the (now-rebased) task branch via a
      // working-tree-free ref update. Unlike `git checkout` + `git merge --ff-only`,
      // `git update-ref` never touches any working tree, so it succeeds even when
      // the main working tree has uncommitted tracked changes or is checked out on
      // a different branch.
      lastStep = 'fast-forward-ancestry'
      const taskSha = (
        await gexec(['rev-parse', branch], repoRoot())
      ).stdout.trim()
      const integrationSha = (
        await gexec(['rev-parse', integrationBranch], repoRoot())
      ).stdout.trim()

      // Confirm fast-forward is valid: integrationSha must be an ancestor of taskSha.
      // `git merge-base --is-ancestor` exits 0 when true, 1 when false.
      const ancestryProbe = await gprobe(
        ['merge-base', '--is-ancestor', integrationSha, taskSha],
        repoRoot(),
      )
      const ancestryOk = ancestryProbe.exitCode === 0

      if (!ancestryOk) {
        // Distinguish a retryable forward advance (integration moved ahead of
        // the tip we rebased onto, so re-rebasing is sufficient) from a
        // non-retryable divergent state (force-push, orphan, etc.) which
        // warrants an immediate abort without burning the retry budget.
        const forwardAdvanceProbe =
          attempt < MAX_MERGE_ATTEMPTS
            ? await gprobe(
                ['merge-base', '--is-ancestor', rebaseBaseSha, integrationSha],
                repoRoot(),
              )
            : { exitCode: 1 }
        const isForwardAdvance = forwardAdvanceProbe.exitCode === 0

        if (isForwardAdvance) {
          retriesAttempted++
          output += `\n[merge attempt ${attempt}/${MAX_MERGE_ATTEMPTS}] integration advanced ${rebaseBaseSha.slice(0, 9)}->${integrationSha.slice(0, 9)}; re-rebasing...`
          await new Promise<void>(r => setTimeout(r, attempt * 150))
          continue
        }

        return {
          merged: false,
          conflictResolved,
          aborted: true,
          output: `fast-forward into ${integrationBranch} not possible: ${integrationSha} is not an ancestor of ${taskSha}.\n${output}`,
          supervisorConversation,
          vegaSessionId,
          retriesAttempted,
        }
      }

      // TEST-ONLY seam: awaited immediately before the CAS update-ref so tests
      // can inject a concurrent integration advance in a deterministic window.
      // Never set onBeforeFastForward in production code.
      await onBeforeFastForward?.()

      // Bare ref update — does not touch any working tree, immune to dirty state.
      // The CAS form `update-ref <ref> <new> <old>` is atomic and rejects if
      // integrationBranch has been advanced concurrently (providing the same
      // race-safety as the file lock, with an additional CAS layer).
      lastStep = 'fast-forward-update-ref'
      firePhase('fast-forward')
      try {
        await gexec(
          ['update-ref', `refs/heads/${integrationBranch}`, taskSha, integrationSha],
          repoRoot(),
        )
      } catch (casError: unknown) {
        const e = casError as { stdout?: string; stderr?: string; message?: string }
        output += (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '')

        // Determine whether the CAS failure is due to a retryable forward
        // advance or a non-retryable divergent state (e.g. force-push, orphan).
        // In normal operation CAS rejections represent forward advances; the
        // divergent guard is a correctness belt-and-suspenders.
        const currentIntegrationSha = (
          await gexec(['rev-parse', integrationBranch], repoRoot())
        ).stdout.trim()
        const casForwardProbe = await gprobe(
          ['merge-base', '--is-ancestor', rebaseBaseSha, currentIntegrationSha],
          repoRoot(),
        )
        const isCasForwardAdvance = casForwardProbe.exitCode === 0

        if (isCasForwardAdvance && attempt < MAX_MERGE_ATTEMPTS) {
          // Retryable forward advance with remaining budget.
          retriesAttempted++
          output += `\n[merge attempt ${attempt}/${MAX_MERGE_ATTEMPTS}] CAS rejected: integration advanced ${rebaseBaseSha.slice(0, 9)}->${currentIntegrationSha.slice(0, 9)}; re-rebasing...`
          await new Promise<void>(r => setTimeout(r, attempt * 150))
          continue
        }

        if (isCasForwardAdvance) {
          // Budget exhausted on a persistent forward advance.
          return {
            merged: false,
            conflictResolved,
            aborted: true,
            output: `integration moved during merge, retry needed: ${integrationBranch} advanced concurrently.\n${output}`,
            supervisorConversation,
            vegaSessionId,
            retriesAttempted,
          }
        }

        // Non-retryable divergent state: abort immediately without burning budget.
        return {
          merged: false,
          conflictResolved,
          aborted: true,
          output: `fast-forward into ${integrationBranch} not possible: ${currentIntegrationSha} is not an ancestor of ${taskSha}.\n${output}`,
          supervisorConversation,
          vegaSessionId,
          retriesAttempted,
        }
      }

      // CAS succeeded: store SHAs for the Step 3 re-sync and exit the retry loop.
      finalTaskSha = taskSha
      finalIntegrationSha = integrationSha
      break
    }

    // Step 3: re-sync the merge target's checkout to the advanced ref.
    // `update-ref` moved refs/heads/<integrationBranch> without touching any
    // working tree — by design, so a dirty/other-branch checkout cannot block
    // the merge. But when the main repo IS checked out on integrationBranch,
    // its index + working tree still reflect the OLD HEAD, so every file the
    // merge introduced now shows as a phantom staged change. That dirty index
    // then trips the dispatch-time `verify:main-dirty` guard and mass-parks
    // the whole queue behind a `main-commiter` recovery (one success poisons
    // every subsequent dispatch).
    //
    // Re-sync ONLY when both hold:
    //   1. HEAD is the integration branch (otherwise update-ref left the
    //      checkout legitimately untouched — see the non-integration test), and
    //   2. the working tree + index are clean *relative to the OLD integration
    //      SHA* the checkout still reflects. We must compare against
    //      finalIntegrationSha, NOT current HEAD: the ref already advanced, so a
    //      plain `git status` would report the just-merged files as "dirty"
    //      even on a pristine checkout and wrongly skip the re-sync.
    // When clean, `git reset --hard <finalTaskSha>` materialises the merged content
    // and leaves `git status` empty. When the operator has real uncommitted
    // edits (a diff vs finalIntegrationSha) we leave the tree as-is rather than
    // clobber them — rare for the daemon's own checkout, and a dirty tree is
    // recoverable where lost edits are not. Failure here is non-fatal: the
    // merge already landed via the ref update; log and continue.
    lastStep = 'resync-working-tree'
    let didResyncWorkingTree = false
    try {
      const headBranch = (
        await gexec(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot())
      ).stdout.trim()
      if (headBranch === integrationBranch) {
        // `git diff --quiet <sha>` exits 0 when the working tree + index match
        // <sha> exactly (no genuine local work), non-zero otherwise. Probe form.
        const diffProbe = await gprobe(
          ['diff', '--quiet', finalIntegrationSha],
          repoRoot(),
        )
        const cleanVsOldHead = diffProbe.exitCode === 0
        if (cleanVsOldHead) {
          const reset = await gexec(['reset', '--hard', finalTaskSha], repoRoot())
          output += reset.stdout + reset.stderr
          didResyncWorkingTree = true
        } else {
          output += `\n[mergeBranch] merge target checkout has local changes vs ${finalIntegrationSha.slice(0, 9)}; left as-is to avoid clobbering (HEAD ref advanced).`
        }
      }
    } catch (resyncError: unknown) {
      const e = resyncError as { stdout?: string; stderr?: string; message?: string }
      output += `\n[mergeBranch] post-merge checkout re-sync failed (merge already landed): ${(e.stderr ?? e.message ?? '').slice(0, 300)}`
    }

    // Integration-gate hook — runs inside the merge lock so that at most one
    // full test suite executes at a time. On failure the fast-forward is
    // reverted so the integration branch is left clean at the pre-merge SHA.
    if (onAfterFastForward) {
      lastStep = 'integration-gate'
      firePhase('integration-gate')
      try {
        await onAfterFastForward({ finalTaskSha, finalIntegrationSha })
      } catch (gateErr: unknown) {
        const gateOutput = gateErr instanceof Error ? gateErr.message : String(gateErr)
        // Revert the fast-forward: roll integration branch back to pre-merge SHA.
        try {
          await gexec(
            ['update-ref', `refs/heads/${integrationBranch}`, finalIntegrationSha, finalTaskSha],
            repoRoot(),
          )
        } catch (revertRefErr: unknown) {
          const m = revertRefErr instanceof Error ? revertRefErr.message : String(revertRefErr)
          output += `\n[merge:integration-gate] ref revert failed: ${m.slice(0, 300)}`
        }
        // If Step 3 performed a `git reset --hard`, undo it so the working
        // tree matches the reverted integration branch.
        if (didResyncWorkingTree) {
          try {
            await gexec(['reset', '--hard', finalIntegrationSha], repoRoot())
          } catch (resetBackErr: unknown) {
            const m = resetBackErr instanceof Error ? resetBackErr.message : String(resetBackErr)
            output += `\n[merge:integration-gate] working-tree reset-back failed: ${m.slice(0, 300)}`
          }
        }
        return {
          merged: false,
          conflictResolved,
          aborted: false,
          integrationGateFailed: true,
          integrationGateOutput: gateOutput,
          output: output + `\n[merge:integration-gate] integration gates failed; fast-forward reverted to ${finalIntegrationSha.slice(0, 9)}`,
          supervisorConversation,
          vegaSessionId,
          retriesAttempted,
        }
      }
    }

    // Belt-and-braces: assert the integration checkout is clean after the merge.
    // `git update-ref` is working-tree-free by design, but Step 3's
    // `git reset --hard` or the gate-revert path can leave the tree dirty when
    // they fail silently or are interrupted. Reporting success over a dirty tree
    // causes every subsequent dispatch to park behind a main-committer Chore
    // (the dirty-main guard fires at dispatch time) and requires operator
    // intervention to unblock the queue.
    //
    // We only assert when the primary checkout is on the integration branch —
    // that is the only checkout we touch in Step 3. Pre-existing dirt on any
    // other branch is the operator's concern, not a merge-step defect.
    //
    // If the tree IS dirty after a successful merge:
    //   1. Attempt `git reset --hard HEAD` to restore it (the branch work is
    //      already in commits — HEAD has advanced to finalTaskSha, so the reset
    //      just materialises what the ref already points at).
    //   2. Fail the step with reason `'merge-left-dirty-tree'` so the normal
    //      failure path handles it. Never report step success over a dirty tree.
    lastStep = 'post-merge-assert'
    try {
      const headBranchPost = (
        await gexec(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot())
      ).stdout.trim()
      if (headBranchPost === integrationBranch) {
        const postStatus = await gprobe(
          ['status', '--porcelain', '--untracked-files=no'],
          repoRoot(),
        )
        if (postStatus.stdout.trim() !== '') {
          output += `\n[mergeBranch] post-merge dirty-tree detected on integration checkout (status:\n${postStatus.stdout.slice(0, 500)}\n)`
          // The dirt is one of two very different things and they must NOT be
          // treated alike:
          //
          //   a) merge-attributable dirt — Step 3's `reset --hard` ran to
          //      completion (didResyncWorkingTree === true) but was somehow
          //      interrupted before the working tree fully settled. HEAD
          //      already points at finalTaskSha, so resetting to HEAD only
          //      materialises content that is already committed. Nothing can
          //      be lost.
          //
          //   b) everything else — the operator's uncommitted work (Step 3 saw
          //      it and explicitly declined to clobber it: "a dirty tree is
          //      recoverable where lost edits are not"), OR Step 3 never got a
          //      chance to classify the tree at all (its own HEAD/diff probes
          //      threw, or the primary checkout was transiently not reporting
          //      as `integrationBranch`). A probe failure leaves
          //      `didResyncWorkingTree` at its initial `false` — indistinguishable,
          //      if we branch on the absence of a separate "operator edits seen"
          //      flag, from "genuinely nothing to worry about". Branching on the
          //      ABSENCE of such a flag is exactly the bug that shipped once
          //      already: a `reset --hard HEAD` here silently destroys
          //      whatever is actually dirty and undoes Step 3's decision (or
          //      papers over the fact Step 3 never got to make one). This
          //      really happened: edits made directly on the integration
          //      checkout vanished mid-session, twice.
          //
          //      So only (a) — positively confirmed by `didResyncWorkingTree`
          //      — takes the plain-reset path. Every other case, including an
          //      unclassified Step 3, defaults to (b): checkpoint first.
          //
          // For (b) we checkpoint instead of resetting. That still leaves a
          // clean tree — so the dispatch-time dirty-main guard does not park the
          // queue — but the work survives as a commit object on this merge's own
          // `refs/mars/checkpoint/<key>` ref, recoverable by name.
          //
          // NOT `git stash`: `refs/stash` is shared by every linked worktree and
          // addressed by shifting positions, so a parallel task's `stash pop`
          // could swallow the operator's edits. A checkpoint ref is per-merge and
          // is restored by object id.
          let preservedByCheckpoint = false
          if (!didResyncWorkingTree) {
            try {
              const key = `merge/${traceCtx?.taskId ?? branch}`
              const checkpoint = await captureCheckpoint({
                cwd: repoRoot(),
                key,
                message: `mars: preserved operator edits displaced by merge of ${finalTaskSha.slice(0, 9)}`,
                traceCtx: mergeCtx,
              })
              if (checkpoint === null) {
                // Nothing capturable (ignored-only dirt): leave the tree alone.
                output += `\n[mergeBranch] operator edits are ignored-only; leaving tree untouched`
              } else {
                await discardWorkingTreeChanges({ cwd: repoRoot(), traceCtx: mergeCtx })
                preservedByCheckpoint = true
                output +=
                  `\n[mergeBranch] PRESERVED operator edits on ${integrationBranch} as checkpoint ref ${checkpoint.ref} ` +
                  `(${checkpoint.sha.slice(0, 9)}). Recover them with: ` +
                  `git -C ${repoRoot()} cherry-pick -n ${checkpoint.ref}; git -C ${repoRoot()} cherry-pick --quit ` +
                  `(the --quit clears the sequencer state left by -n; index and worktree are kept). Files: ` +
                  `${checkpoint.files.join(', ').slice(0, 200)}`
              }
            } catch (checkpointErr: unknown) {
              const m =
                checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr)
              // Could not checkpoint — leave the tree exactly as it is. A dirty
              // tree parks the queue, which is annoying; destroying the edits is
              // worse.
              output += `\n[mergeBranch] could not checkpoint operator edits, leaving tree untouched: ${m.slice(0, 300)}`
            }
          } else {
            // didResyncWorkingTree === true: Step 3 positively confirmed it
            // already reset this exact checkout to finalTaskSha. Any dirt
            // found here can only be debris from that same reset being
            // interrupted, so restoring to the current HEAD (== finalTaskSha,
            // already landed via update-ref) cannot lose anything.
            try {
              const restored = await gexec(['reset', '--hard', 'HEAD'], repoRoot())
              output += `\n[mergeBranch] restored integration checkout to HEAD: ${restored.stdout.trim().slice(0, 200)}`
            } catch (restoreErr: unknown) {
              const m = restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
              output += `\n[mergeBranch] restore-to-HEAD failed: ${m.slice(0, 300)}`
            }
          }
          // A successful checkpoint leaves the tree clean and the merge already
          // landed via update-ref, so there is nothing left to report as a
          // failure. Every other path still returns 'merge-left-dirty-tree' so
          // the normal failure handling runs and we never claim success over a
          // tree we could not clean.
          if (!preservedByCheckpoint) {
            return {
              merged: false,
              conflictResolved,
              aborted: false,
              reason: 'merge-left-dirty-tree',
              output,
              supervisorConversation,
              vegaSessionId,
              retriesAttempted,
            }
          }
        }
      }
    } catch (assertErr: unknown) {
      // Non-fatal: the merge already landed. Log and continue so we report
      // merged:true rather than swallowing a spurious assertion error.
      const m = assertErr instanceof Error ? assertErr.message : String(assertErr)
      output += `\n[mergeBranch] post-merge tree assertion failed to run: ${m.slice(0, 300)}`
    }

    return {
      merged: true,
      conflictResolved,
      aborted: false,
      output,
      supervisorConversation,
      vegaSessionId,
      retriesAttempted,
      // SHAs for the Scorer runtime: `git diff mergePreSha mergePostSha`
      // reconstructs the merged diff after the worktree is removed.
      mergePreSha: finalIntegrationSha,
      mergePostSha: finalTaskSha,
    }
    })(),
    abortPromise,
    ])
    } finally {
      // Clear the heartbeat timer and release the merge lock regardless of how
      // the merge body exits — success, early return, or abort.
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      await release()
    }
  } catch (err: unknown) {
    // Convert an abort (watchdog OR caller signal) into a MergeAbortedError.
    // Any other error is a genuine merge failure and propagates unchanged.
    if (combinedSignal.aborted) {
      const reason: 'watchdog' | 'external' = watchdogController.signal.aborted
        ? 'watchdog'
        : 'external'
      // Best-effort teardown of any in-progress rebase/merge in the worktree.
      // Bounded by its own short timeout — never threads the aborted signal.
      await bestEffortAbortCleanup(worktreePath, mergeCtx)
      throw new MergeAbortedError(reason, Date.now() - startedAt, lastStep)
    }
    throw err
  } finally {
    clearTimeout(watchdogTimer)
  }
}

/**
 * Returns `true` when `branchTipSha` is reachable from `integrationBranch`
 * (i.e. the fast-forward ref update landed). The single
 * `merge-base --is-ancestor` probe is sufficient: if the update succeeded, the
 * integration branch now points AT `branchTipSha` or has it as an ancestor; if
 * the update was silently skipped or a no-op misclassified, `branchTipSha` is
 * NOT reachable from the integration tip.
 *
 * Called by the `merge` primitive immediately after `mergeBranch` returns
 * `merged: true` with a `mergePostSha` to guard against the silent-data-loss
 * path where the task is marked `done` and the branch deleted even though
 * the ref update never happened.
 */
export const isBranchTipInIntegration = async (
  branchTipSha: string,
  integrationBranch: string,
): Promise<boolean> => {
  const probe = await execProbe(
    resolveGitBin(),
    ['merge-base', '--is-ancestor', branchTipSha, integrationBranch],
    { cwd: repoRoot() },
  )
  return probe.exitCode === 0
}

export const isBranchMergedIntoMain = async (
  branch: string,
  repoRoot: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  const probe = await execProbe(
    resolveGitBin(),
    ['merge-base', '--is-ancestor', branch, 'main'],
    { cwd: repoRoot },
    traceCtx,
  )
  if (probe.exitCode !== 0) return false
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['rev-list', '--count', `${branch}..main`],
      { cwd: repoRoot },
      traceCtx,
    )
    const mainAhead = Number.parseInt(stdout.trim(), 10)
    if (!Number.isFinite(mainAhead)) return false
    return mainAhead === 0
  } catch {
    return false
  }
}

export const isZeroCommitBranch = async (
  branch: string,
  repoRoot: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  try {
    const { stdout: tip } = await exec(
      resolveGitBin(),
      ['rev-parse', branch],
      { cwd: repoRoot },
      traceCtx,
    )
    const { stdout: base } = await exec(
      resolveGitBin(),
      ['merge-base', branch, 'main'],
      { cwd: repoRoot },
      traceCtx,
    )
    return tip.trim() === base.trim()
  } catch {
    return false
  }
}

/**
 * PATCH-CONTENT comparison of `branch` against `integrationBranch`, using
 * `git cherry` (patch-id) rather than commit-object identity.
 *
 * The zero-commit-branch collapse (see `isZeroCommitBranch`) is
 * irreversible-looking once it has happened: after a rebase silently drops a
 * branch's commits because they are already patch-equivalent-present
 * upstream (e.g. a sibling recovery task committed and merged the identical
 * diff under different SHAs first), the branch tip equals the integration
 * tip and there is no git state left that distinguishes "already landed" from
 * "never had any commits" — both converge to the same rev-parse/merge-base
 * answer. This function must therefore be called BEFORE that rebase mutates
 * the branch (e.g. at the `mars remerge` entry point), while the branch's
 * original commits are still intact and comparable by patch-id.
 *
 * Returns `true` only when `branch` has at least one commit not reachable
 * from `integrationBranch` (by SHA) AND every one of those commits is
 * patch-equivalent to a commit `git cherry` already finds reachable from
 * `integrationBranch` (i.e. `git cherry` marks every line `-`). Returns
 * `false` when `branch` has no commits ahead of `integrationBranch` at all
 * (nothing to compare — that is the "never had commits" shape, a distinct
 * condition callers should detect separately via plain SHA reachability) or
 * when at least one commit ahead is genuinely new (`+`).
 */
export const isBranchPatchLandedInIntegration = async (
  branch: string,
  integrationBranch: string,
  repoRoot: string,
  traceCtx?: TraceCtx,
): Promise<boolean> => {
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['cherry', integrationBranch, branch],
      { cwd: repoRoot },
      traceCtx,
    )
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (lines.length === 0) return false
    return lines.every((line) => line.startsWith('-'))
  } catch {
    return false
  }
}
