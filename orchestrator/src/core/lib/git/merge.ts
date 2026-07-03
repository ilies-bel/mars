import { resolve } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { getStateDir } from '../../context'
import { parseClaudeStreamLine, type ClaudeEvent } from '../claude-stream'
import {
  exec,
  execProbe,
  resolveGitBin,
  repoRoot,
  moduleDir,
  type TraceCtx,
} from './internal'
import { acquireLock } from './lock'
import {
  runSubprocessStreaming,
  resolveClaudeBin,
  claudeStreamArgs,
  buildWorkerEnv,
  extractSessionIdFromConversation,
  type RunSubprocessResult,
} from './claude'

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

    const diff = await exec(
      resolveGitBin(),
      ['diff', '--name-only', `${integrationBranch}..${taskBranch}`],
      { cwd: targetPath },
      mergeCtx,
    )
    const changedPaths = diff.stdout.split('\n').filter((p) => p.length > 0)
    if (changedPaths.length === 0) return { kind: 'clean' }

    // Cap pathspec argv to avoid blowing past ARG_MAX on huge diffs; if we
    // exceed it, fall back to a tracked-only global status. Untracked files
    // are still ignored — they cannot block an ff.
    const PATH_CAP = 500
    const statusArgs = ['status', '--porcelain', '--untracked-files=no']
    if (changedPaths.length <= PATH_CAP) {
      statusArgs.push('--', ...changedPaths)
    }
    const status = await exec(
      resolveGitBin(),
      statusArgs,
      { cwd: targetPath },
      mergeCtx,
    )
    if (status.stdout.length === 0) return { kind: 'clean' }
    return {
      kind: 'dirty',
      targetPath,
      statusOutput: `tracked changes on paths the fast-forward would update:\n${status.stdout}`,
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

export interface MergeArgs {
  branch: string
  worktreePath: string
  integrationBranch: string
  lockTimeoutMs: number
  /** Optional trace context. Default phase is `merge` when omitted. */
  traceCtx?: TraceCtx
  onSupervisorEvent?: (event: ClaudeEvent) => void | Promise<void>
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
}

export interface MergeResult {
  merged: boolean
  conflictResolved: boolean
  aborted: boolean
  output: string
  supervisorConversation: ClaudeEvent[]
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

interface InvokeSupervisorResult extends RunSubprocessResult {
  conversation: ClaudeEvent[]
}

const invokeVcsSupervisor = async (
  branch: string,
  integrationBranch: string,
  cwd: string,
  timeoutMs: number,
  onEvent?: (event: ClaudeEvent) => void | Promise<void>,
): Promise<InvokeSupervisorResult> => {
  const prompt = await buildSupervisorPrompt(branch, integrationBranch)
  const conversation: ClaudeEvent[] = []
  const work = runSubprocessStreaming(
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
    undefined,
    buildWorkerEnv(),
  )
  const timeout = new Promise<RunSubprocessResult>((resolveFn) =>
    setTimeout(
      () =>
        resolveFn({
          exitCode: 124,
          stdout: '',
          stderr: `vcs-supervisor timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    ),
  )
  const result = await Promise.race([work, timeout])
  return { ...result, conversation }
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
): Promise<boolean> => {
  try {
    const { stdout } = await exec(
      resolveGitBin(),
      ['rev-parse', '--git-path', 'rebase-merge'],
      { cwd },
      traceCtx,
    )
    const mergePath = stdout.trim()
    const { stdout: applyStdout } = await exec(
      resolveGitBin(),
      ['rev-parse', '--git-path', 'rebase-apply'],
      { cwd },
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

export const mergeBranch = async ({
  branch,
  worktreePath,
  integrationBranch,
  lockTimeoutMs,
  onSupervisorEvent,
  onVegaStart,
  onBeforeFastForward,
  onAfterFastForward,
  traceCtx,
}: MergeArgs): Promise<MergeResult> => {
  const mergeCtx: TraceCtx | undefined = traceCtx
    ? { ...traceCtx, phase: traceCtx.phase ?? 'merge' }
    : undefined
  const release = await acquireLock(
    resolve(getStateDir(), '.merge.lock'),
    lockTimeoutMs,
  )
  try {
    let output = ''
    let conflictResolved = false
    let vegaSessionId: string | null = null
    const supervisorConversation: ClaudeEvent[] = []
    let retriesAttempted = 0

    // finalTaskSha / finalIntegrationSha are written on CAS success inside the
    // loop and consumed by Step 3 outside it. The loop always exits via break
    // (success) or return (abort), so these are always set before Step 3 runs.
    let finalTaskSha = ''
    let finalIntegrationSha = ''

    for (let attempt = 1; attempt <= MAX_MERGE_ATTEMPTS; attempt++) {
      // Capture the integration tip BEFORE rebasing so we can later distinguish
      // a retryable forward advance from a non-retryable divergent state when
      // the ancestry check or CAS indicates integration has moved.
      const rebaseBaseSha = (
        await exec(resolveGitBin(), ['rev-parse', integrationBranch], { cwd: repoRoot() }, mergeCtx)
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
      const rebaseResult = await execProbe(
        resolveGitBin(),
        ['rebase', integrationBranch],
        { cwd: worktreePath },
        mergeCtx,
      )
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
        const rebaseInProgress = await isRebaseInProgress(worktreePath, mergeCtx)
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
        await onVegaStart?.()

        const preSha = (
          await exec(resolveGitBin(), ['rev-parse', branch], { cwd: repoRoot() }, mergeCtx)
        ).stdout.trim()

        const supervisorTimeoutMs = 30 * 60 * 1000
        const sup = await invokeVcsSupervisor(
          branch,
          integrationBranch,
          worktreePath,
          supervisorTimeoutMs,
          onSupervisorEvent,
        )
        supervisorConversation.push(...sup.conversation)
        output += sup.stdout + sup.stderr

        const stillInProgress = await isRebaseInProgress(worktreePath, mergeCtx)
        const postSha = (
          await exec(resolveGitBin(), ['rev-parse', branch], { cwd: repoRoot() }, mergeCtx)
        ).stdout.trim()
        const advanced = postSha !== preSha
        const treeClean = await (async () => {
          // `git diff --quiet` is a probe: exit 0 = clean, exit 1 = dirty.
          const a = await execProbe(
            resolveGitBin(),
            ['diff', '--quiet'],
            { cwd: worktreePath },
            mergeCtx,
          )
          if (a.exitCode !== 0) return false
          const b = await execProbe(
            resolveGitBin(),
            ['diff', '--cached', '--quiet'],
            { cwd: worktreePath },
            mergeCtx,
          )
          return b.exitCode === 0
        })()

        if (stillInProgress || !advanced || !treeClean) {
          await execProbe(
            resolveGitBin(),
            ['rebase', '--abort'],
            { cwd: worktreePath },
            mergeCtx,
          ).catch(() => {})
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
      const taskSha = (
        await exec(resolveGitBin(), ['rev-parse', branch], { cwd: repoRoot() }, mergeCtx)
      ).stdout.trim()
      const integrationSha = (
        await exec(resolveGitBin(), ['rev-parse', integrationBranch], { cwd: repoRoot() }, mergeCtx)
      ).stdout.trim()

      // Confirm fast-forward is valid: integrationSha must be an ancestor of taskSha.
      // `git merge-base --is-ancestor` exits 0 when true, 1 when false.
      const ancestryProbe = await execProbe(
        resolveGitBin(),
        ['merge-base', '--is-ancestor', integrationSha, taskSha],
        { cwd: repoRoot() },
        mergeCtx,
      )
      const ancestryOk = ancestryProbe.exitCode === 0

      if (!ancestryOk) {
        // Distinguish a retryable forward advance (integration moved ahead of
        // the tip we rebased onto, so re-rebasing is sufficient) from a
        // non-retryable divergent state (force-push, orphan, etc.) which
        // warrants an immediate abort without burning the retry budget.
        const forwardAdvanceProbe =
          attempt < MAX_MERGE_ATTEMPTS
            ? await execProbe(
                resolveGitBin(),
                ['merge-base', '--is-ancestor', rebaseBaseSha, integrationSha],
                { cwd: repoRoot() },
                mergeCtx,
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
      try {
        await exec(
          resolveGitBin(),
          ['update-ref', `refs/heads/${integrationBranch}`, taskSha, integrationSha],
          { cwd: repoRoot() },
          mergeCtx,
        )
      } catch (casError: unknown) {
        const e = casError as { stdout?: string; stderr?: string; message?: string }
        output += (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '')

        // Determine whether the CAS failure is due to a retryable forward
        // advance or a non-retryable divergent state (e.g. force-push, orphan).
        // In normal operation CAS rejections represent forward advances; the
        // divergent guard is a correctness belt-and-suspenders.
        const currentIntegrationSha = (
          await exec(resolveGitBin(), ['rev-parse', integrationBranch], { cwd: repoRoot() }, mergeCtx)
        ).stdout.trim()
        const casForwardProbe = await execProbe(
          resolveGitBin(),
          ['merge-base', '--is-ancestor', rebaseBaseSha, currentIntegrationSha],
          { cwd: repoRoot() },
          mergeCtx,
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
    let didResyncWorkingTree = false
    try {
      const headBranch = (
        await exec(
          resolveGitBin(),
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          { cwd: repoRoot() },
          mergeCtx,
        )
      ).stdout.trim()
      if (headBranch === integrationBranch) {
        // `git diff --quiet <sha>` exits 0 when the working tree + index match
        // <sha> exactly (no genuine local work), non-zero otherwise. Probe form.
        const diffProbe = await execProbe(
          resolveGitBin(),
          ['diff', '--quiet', finalIntegrationSha],
          { cwd: repoRoot() },
          mergeCtx,
        )
        const cleanVsOldHead = diffProbe.exitCode === 0
        if (cleanVsOldHead) {
          const reset = await exec(
            resolveGitBin(),
            ['reset', '--hard', finalTaskSha],
            { cwd: repoRoot() },
            mergeCtx,
          )
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
      try {
        await onAfterFastForward({ finalTaskSha, finalIntegrationSha })
      } catch (gateErr: unknown) {
        const gateOutput = gateErr instanceof Error ? gateErr.message : String(gateErr)
        // Revert the fast-forward: roll integration branch back to pre-merge SHA.
        try {
          await exec(
            resolveGitBin(),
            ['update-ref', `refs/heads/${integrationBranch}`, finalIntegrationSha, finalTaskSha],
            { cwd: repoRoot() },
            mergeCtx,
          )
        } catch (revertRefErr: unknown) {
          const m = revertRefErr instanceof Error ? revertRefErr.message : String(revertRefErr)
          output += `\n[merge:integration-gate] ref revert failed: ${m.slice(0, 300)}`
        }
        // If Step 3 performed a `git reset --hard`, undo it so the working
        // tree matches the reverted integration branch.
        if (didResyncWorkingTree) {
          try {
            await exec(
              resolveGitBin(),
              ['reset', '--hard', finalIntegrationSha],
              { cwd: repoRoot() },
              mergeCtx,
            )
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

    return {
      merged: true,
      conflictResolved,
      aborted: false,
      output,
      supervisorConversation,
      vegaSessionId,
      retriesAttempted,
    }
  } finally {
    await release()
  }
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
