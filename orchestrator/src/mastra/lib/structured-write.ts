import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  createWorktree,
  removeWorktree,
  mergeBranch,
  checkMergeTargetStatus,
  type MergeResult,
} from './git'
import { runTool, nullTraceStore, type TraceCtx } from './run-tool'

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
  /** Optional override for the merge lock timeout (default 5 min). */
  lockTimeoutMs?: number
  /** Optional trace context. Populated when called from a workflow phase;
   *  omitted by direct CLI entry points (e.g. `mars glossary set`). */
  traceCtx?: TraceCtx
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
  const lockTimeoutMs = args.lockTimeoutMs ?? 5 * 60 * 1000

  // Writer preflight runs before the worktree exists, so there is no task
  // branch yet. Self-check the integration ref: an integration-vs-integration
  // ff is trivially clean unless the ref itself is broken, in which case we
  // surface 'error' and abort below.
  const target = await checkMergeTargetStatus({
    integrationBranch: integration,
    taskBranch: integration,
  })
  if (target.kind === 'dirty') {
    return {
      kind: 'aborted',
      reason: `merge target dirty: ${target.targetPath}`,
      output: target.statusOutput,
    }
  }
  if (target.kind === 'error') {
    return {
      kind: 'aborted',
      reason: `merge target check failed: ${target.error.message}`,
      output: '',
    }
  }

  const writeId = `${args.kind}-${shortId()}`
  const worktree = await createWorktree({
    taskId: writeId,
    integrationBranch: integration,
    branchSuffix: args.kind,
  })

  let merge: MergeResult | null = null
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

    merge = await mergeBranch({
      branch: worktree.branch,
      worktreePath: worktree.path,
      integrationBranch: integration,
      lockTimeoutMs,
    })

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
