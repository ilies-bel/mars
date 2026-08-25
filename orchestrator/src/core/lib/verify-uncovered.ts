/**
 * Raiser for the `verify-uncovered` action-queue kind.
 *
 * Raises a durable alert when a task merges without any task-tier verify gate
 * covering its changed files (the `CAN'T-VERIFY: no task-tier verify gate
 * covers the changed files` outcome from `git/verify.ts`).
 *
 * Deduplication is by coverage fingerprint — the sorted, normalised set of
 * changed paths — rather than by task id. Unrelated tasks that hit the same
 * coverage gap collapse into a single open row, and `seen_count` accumulates
 * until an operator adds a covering gate (which resolves the row via
 * `resolveCoveredVerifyAlerts` in `verify-gates.ts`).
 *
 * This module does NOT swallow errors. Callers must wrap in `.catch()` and log
 * the failure — a DB error here must never turn a `CAN'T-VERIFY` verdict into
 * `FAIL` in the calling pipeline.
 */

import { createHash } from 'node:crypto'
import { raiseActionQueueItem } from './action-queue.js'
import type { VerifyUncoveredPayload } from './payload-contracts/verify.js'

/** Normalise, sort and deduplicate a list of changed paths. */
const normalizePaths = (paths: string[]): string[] =>
  [...new Set(paths.map((p) => p.trim()).filter(Boolean))].sort()

/**
 * Derive a deterministic hex fingerprint from a sorted set of paths.
 * Two calls with the same file set (in any order) produce the same key.
 */
const computeScopeFingerprint = (sortedPaths: string[]): string =>
  createHash('sha1').update(sortedPaths.join('\n')).digest('hex').slice(0, 16)

/**
 * Derive the narrowest common scope descriptor for a set of changed paths.
 *
 * - Single path  → the path itself (a file-level gate would cover it directly).
 * - Multiple paths → the common directory prefix (trimmed to the last `/`
 *   segment boundary). If paths share no common directory, returns `'.'`.
 * - Empty list   → `'.'` (caller should guard against this case).
 *
 * The returned value is what an operator would use as the `scope` argument
 * when running `mars verify-gate add` to cover this gap. It is also what
 * `resolveCoveredVerifyAlerts` in `verify-gates.ts` tests against when a new
 * gate is registered.
 */
const deriveScope = (sortedPaths: string[]): string => {
  if (sortedPaths.length === 0) return '.'
  if (sortedPaths.length === 1) return sortedPaths[0]
  // Alphabetically sorted: first and last are the most divergent pair.
  const first = sortedPaths[0]
  const last = sortedPaths[sortedPaths.length - 1]
  let i = 0
  while (i < first.length && i < last.length && first[i] === last[i]) i++
  const commonPrefix = first.slice(0, i)
  // Trim to the last '/' segment boundary (never leave a partial path segment).
  const boundary = commonPrefix.lastIndexOf('/')
  return boundary >= 0 ? commonPrefix.slice(0, boundary) : '.'
}

/**
 * Raise a durable `verify-uncovered` action-queue row for a task that merged
 * without any task-tier verify gate covering its changed files.
 *
 * The row is keyed by a fingerprint of the (normalised, sorted) changed paths
 * rather than by task id, so multiple tasks hitting the same coverage gap
 * accumulate `seen_count` on a single open row rather than spawning duplicates.
 *
 * When the operator subsequently adds a gate whose scope covers all of the
 * paths listed in `payload.changedPaths`, `resolveCoveredVerifyAlerts` (called
 * from `addVerifyGate` in `verify-gates.ts`) will flip the row to `resolved`
 * automatically.
 *
 * Throws on DB failure. Callers MUST wrap in `.catch()` — a raise failure must
 * never propagate into the verify pipeline and must never convert a
 * `CAN'T-VERIFY` verdict into `FAIL`.
 */
export const reportUncoveredVerifyCoverage = async (args: {
  changedPaths: string[]
  taskId?: string
  proposedGate?: VerifyUncoveredPayload['proposedGate']
}): Promise<void> => {
  const normalized = normalizePaths(args.changedPaths)
  if (normalized.length === 0) return // Nothing changed — nothing to report.

  const scope = deriveScope(normalized)
  const fingerprint = computeScopeFingerprint(normalized)
  const signature = `verify-uncovered:${fingerprint}`

  const pathSummary =
    normalized.slice(0, 3).join(', ') +
    (normalized.length > 3 ? ` (+${normalized.length - 3} more)` : '')

  await raiseActionQueueItem({
    kind: 'verify-uncovered',
    category: 'orchestrator',
    priority: 'normal',
    title: `No verify gate covers changed files${scope !== '.' ? ` in ${scope}` : ''}`,
    body: `Task merged without any check covering: ${pathSummary}`,
    payload: {
      scope,
      changedPaths: normalized,
      recipe: null,
      ...(args.proposedGate ? { proposedGate: args.proposedGate } : {}),
    },
    context: args.taskId != null ? { taskId: args.taskId } : {},
    raisedBy: 'verify:no-gate-coverage',
    signature,
    // No originTaskId — deduplication is by coverage fingerprint, not by task.
  })
}
