import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import {
  createWorktree,
  removeWorktree,
  mergeBranch,
  checkMergeTargetStatus,
  type MergeResult,
} from './git'

const exec = promisify(execFile)

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
}

export type StructuredWriteOutcome =
  | { kind: 'merged'; conflictResolved: boolean; output: string }
  | { kind: 'noop' }
  | { kind: 'aborted'; reason: string; output: string }

const integrationFromEnv = (): string =>
  process.env.INTEGRATION_BRANCH ?? 'integration'

const stagedHasChanges = async (cwd: string): Promise<boolean> => {
  const { stdout } = await exec('git', ['status', '--porcelain'], { cwd })
  return stdout.length > 0
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

  const target = await checkMergeTargetStatus()
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

    if (!(await stagedHasChanges(worktree.path))) {
      return { kind: 'noop' }
    }

    await exec('git', ['add', '-A'], { cwd: worktree.path })
    await exec(
      'git',
      ['commit', '-m', args.commitMessage],
      { cwd: worktree.path },
    )

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
