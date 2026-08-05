import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createWorktree, removeWorktree } from './git/worktree'
import {
  checkMergeTargetStatus,
  type MergeResult,
} from './git/merge'
import { runTool, nullTraceStore, type TraceCtx } from './run-tool'
import { getRepoRoot } from '../context'

/**
 * Outcome delivered by the injected `enqueueMerge` function. Mirrors the
 * `MergeJobResult` type from `daemon/merge-worker` without importing from that
 * module (which would create a lib→daemon circular dependency).
 */
type EnqueueMergeResult =
  | { status: 'done'; result: MergeResult }
  | { status: 'failed'; error: string; errorCode: string }

export interface StructuredWriteArgs {
  /** Short kind tag, used as the branch prefix (e.g. "glossary", "adr"). */
  kind: string
  /** Branch we merge back into. Defaults to env or "integration". */
  integrationBranch?: string
  /** Commit message for the change. */
  commitMessage: string
  /**
   * Mutator runs inside the worktree. Return `false` to indicate "no change"
   * — the worktree will be torn down and the call will resolve as a no-op.
   */
  mutate: (worktreePath: string) => Promise<boolean | void>
  /** Optional trace context. Populated when called from a workflow phase;
   *  omitted by direct CLI entry points (e.g. `mars glossary set`). */
  traceCtx?: TraceCtx
  /**
   * Enqueue a merge job through the durable single-consumer merge worker and
   * wait for completion. Required — there is no fallback to inline
   * `mergeBranch` (that reintroduces the stash-guard footgun for
   * structured-write paths).
   *
   * In production wire this to `enqueueMergeJobAndAwait` from
   * `daemon/merge-worker`. In tests provide a direct-`mergeBranch` shim.
   */
  enqueueMerge: (args: {
    taskId: string
    branch: string
    worktreePath: string
    integrationBranch: string
  }) => Promise<EnqueueMergeResult>
}

export type StructuredWriteOutcome =
  | { kind: 'merged'; conflictResolved: boolean; output: string }
  | { kind: 'noop' }
  | { kind: 'aborted'; reason: string; output: string }

const integrationFromEnv = (): string =>
  process.env.INTEGRATION_BRANCH ?? 'main'

const stagedHasChanges = async (
  cwd: string,
  traceCtx: TraceCtx | undefined,
): Promise<boolean> => {
  // `git status --porcelain` is a probe: empty output means a clean tree, any
  // output means dirty. Non-zero exit (e.g. cwd not a git repo) IS an error;
  // the bare non-zero distinction is fine — we keep expectsFailure off so a
  // failure surfaces as a real `error` in the trace.
  const r = await runTool(
    {
      tool: 'git',
      argv: ['status', '--porcelain'],
      cwd,
      taskId: traceCtx?.taskId ?? null,
      originId: traceCtx?.originId ?? null,
      phase: traceCtx?.phase ?? null,
    },
    traceCtx?.store ?? nullTraceStore,
  )
  if (r.exitCode !== 0) {
    throw new Error(`git status --porcelain failed (exit ${r.exitCode}): ${r.stderr}`)
  }
  return r.stdout.length > 0
}

const shortId = (): string => randomUUID().slice(0, 8)

/**
 * Run a deterministic, no-LLM filesystem mutation on a fresh worktree, commit
 * it, and merge it back into the integration branch using the existing merge
 * lock + vcs-supervisor pipeline. The caller's main checkout is briefly
 * touched only by the final fast-forward step inside `mergeBranch`.
 */
export const runStructuredWrite = async (
  args: StructuredWriteArgs,
): Promise<StructuredWriteOutcome> => {
  const integration = args.integrationBranch ?? integrationFromEnv()
  // writeId is used both as the worktree/branch id and as the merge-job taskId
  // that identifies this structured write in the merge queue.
  const writeId = `${args.kind}-${shortId()}`

  // Dirty-main preflight: check for uncommitted operator edits on the
  // integration checkout BEFORE creating a worktree. This avoids the
  // stash-guard footgun in mergeBranch that can displace in-progress work.
  //
  // `checkMergeTargetStatus` with integration..integration produces an empty
  // diff and returns 'clean' regardless of working-tree dirt (it only checks
  // paths the fast-forward would overwrite). We therefore probe dirty-main
  // explicitly here via `checkIntegrationBranchDirty`.
  {
    const { checkIntegrationBranchDirty } = await import('./main-dirty')
    const dirty = await checkIntegrationBranchDirty({
      repoRoot: getRepoRoot(),
      integrationBranch: integration,
      traceCtx: { taskId: writeId, phase: 'merge', store: args.traceCtx?.store ?? nullTraceStore },
    })
    if (dirty.dirty) {
      // Raise an action-queue item so the operator knows to clean main and
      // re-run. Best-effort: if the DB is unavailable we still return aborted.
      const { raiseActionQueueItem } = await import('./action-queue')
      raiseActionQueueItem({
        kind: 'failed',
        category: 'orchestrator',
        priority: 'high',
        title: `Structured write aborted: ${integration} has uncommitted changes — clean main and re-run \`mars ${args.kind}\``,
        body: [
          `A structured write operation (\`${args.kind}\`) was aborted because the integration branch (\`${integration}\`) has uncommitted changes.`,
          '',
          `The operation did **not** stash or discard your work. Once you commit or stash the changes listed below, re-run the original command.`,
          '',
          'Dirty paths:',
          '```',
          dirty.statusOutput,
          '```',
        ].join('\n'),
        payload: { kind: args.kind, integrationBranch: integration, statusOutput: dirty.statusOutput },
        context: { repoRoot: process.env.MARS_REPO ?? null },
        raisedBy: 'structured-write:dirty-main',
        signature: `structured-write:dirty-main:${integration}`,
      }).catch((err: unknown) => {
        console.error(`[structured-write] dirty-main action-queue raise failed:`, err)
      })
      return {
        kind: 'aborted',
        reason: `merge target dirty: ${integration} has uncommitted changes`,
        output: dirty.statusOutput,
      }
    }
  }

  // Ref-existence check: verify the integration branch resolves before we
  // create a worktree off it. An error here (broken ref, not a git repo, …)
  // is surfaced as 'aborted' so the caller can log it and release the slot.
  const target = await checkMergeTargetStatus({
    integrationBranch: integration,
    taskBranch: integration,
  })
  if (target.kind === 'error') {
    return {
      kind: 'aborted',
      reason: `merge target check failed: ${target.error.message}`,
      output: '',
    }
  }

  // Merge jobs deliberately retain their task_id foreign key. Structured
  // writes are not queued work, but they do use the same durable merge queue
  // as every other branch; a terminal bookkeeping row gives that queue a real
  // task identity without making this write dispatchable or recoverable.
  const { getDefaultTaskStore } = await import('../store/task-store')
  const taskStore = await getDefaultTaskStore()
  const now = new Date().toISOString()
  await taskStore.execute({
    sql: `INSERT INTO tasks
            (id, prompt, status, kind, origin_id, created_at, updated_at)
          VALUES (?, ?, 'done', 'structured-write', ?, ?, ?)`,
    args: [
      writeId,
      `Structured ${args.kind} write bookkeeping`,
      writeId,
      now,
      now,
    ],
  })

  const worktree = await createWorktree({
    taskId: writeId,
    integrationBranch: integration,
    branchSuffix: args.kind,
  })

  try {
    const result = await args.mutate(worktree.path)
    if (result === false) {
      return { kind: 'noop' }
    }

    if (!(await stagedHasChanges(worktree.path, args.traceCtx))) {
      return { kind: 'noop' }
    }

    const wtTrace = {
      taskId: args.traceCtx?.taskId ?? null,
      originId: args.traceCtx?.originId ?? null,
      phase: args.traceCtx?.phase ?? null,
    }
    const wtStore = args.traceCtx?.store ?? nullTraceStore
    const addResult = await runTool(
      { tool: 'git', argv: ['add', '-A'], cwd: worktree.path, ...wtTrace },
      wtStore,
    )
    if (addResult.exitCode !== 0) {
      throw new Error(
        `git add -A failed (exit ${addResult.exitCode}): ${addResult.stderr}`,
      )
    }
    const commitResult = await runTool(
      {
        tool: 'git',
        argv: ['commit', '-m', args.commitMessage],
        cwd: worktree.path,
        ...wtTrace,
      },
      wtStore,
    )
    if (commitResult.exitCode !== 0) {
      throw new Error(
        `git commit failed (exit ${commitResult.exitCode}): ${commitResult.stderr}`,
      )
    }

    const queueResult = await args.enqueueMerge({
      taskId: writeId,
      branch: worktree.branch,
      worktreePath: worktree.path,
      integrationBranch: integration,
    })

    if (queueResult.status === 'failed') {
      return {
        kind: 'aborted',
        reason: `merge job failed (${queueResult.errorCode}): ${queueResult.error}`,
        output: '',
      }
    }
    const merge = queueResult.result

    if (merge.aborted) {
      return {
        kind: 'aborted',
        reason: 'vcs-supervisor could not reconcile merge',
        output: merge.output,
      }
    }

    return {
      kind: 'merged',
      conflictResolved: merge.conflictResolved,
      output: merge.output,
    }
  } finally {
    if (existsSync(worktree.path)) {
      await removeWorktree(worktree, true).catch(() => {})
    }
  }
}
