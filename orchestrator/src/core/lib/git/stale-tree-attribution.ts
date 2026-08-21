/**
 * Slice 2 of PRD ce46f01e: the stale-tree attribution predicate.
 *
 * After a merge fast-forwards `main`'s ref, the primary checkout's working
 * tree can be left one commit behind its own HEAD (see `mergeBranch`'s
 * Step 3 re-sync in `merge.ts`). When that happens, `git status` on the
 * integration checkout reports dirt that LOOKS like an operator edit but is
 * actually just the checkout catching up with the ref it already advanced —
 * e.g. the incident shape this module's test reproduces: a 94-line file the
 * merge just added shows up as a *deletion* in the stale working tree,
 * because the tree still reflects the pre-merge commit.
 *
 * This module answers, precisely: is the dirt on `repoRoot` right now
 * EXACTLY the inverse of the range the checkout just fast-forwarded through
 * (`lastSyncedSha..headSha`), or does it contain anything else? The inverse
 * of `lastSyncedSha..headSha` is `git diff headSha lastSyncedSha` (source and
 * target swapped) — applying that patch to a tree at `headSha` reproduces the
 * tree at `lastSyncedSha`, which is exactly what a stale (one-merge-behind)
 * working tree looks like relative to its own HEAD.
 *
 * Classification is deliberately exact, not fuzzy: patch-for-patch equality
 * (after normalising away blob-hash `index` lines, which legitimately differ
 * between a working-tree diff and a commit-to-commit diff even when the
 * content is identical) or it is NOT attributed to staleness. Any mismatch —
 * including so much as one extra operator-modified file — falls back to
 * `operator-dirt`, the fail-safe default a caller can use to gate an
 * automatic reset. `lastSyncedSha === null` (unknown provenance) always
 * yields `operator-dirt` for the same reason: never reset a tree we cannot
 * positively attribute.
 */
import { exec, execProbe, resolveGitBin } from './internal'
import type { TraceCtx } from './internal'

export type IntegrationDirtAttribution =
  | { kind: 'clean' }
  | { kind: 'stale-tree-debris'; range: string }
  | { kind: 'operator-dirt'; statusOutput: string }

export interface AttributeIntegrationDirtInput {
  /** Repo root where the integration branch is checked out (NOT a worktree). */
  repoRoot: string
  /**
   * The SHA the checkout's working tree was last resynced to, or `null` when
   * unknown / never recorded. `null` always yields `operator-dirt` — see
   * module doc.
   */
  lastSyncedSha: string | null
  /** The current tip of the integration branch (the ref's HEAD). */
  headSha: string
  /** Optional trace context threaded through the underlying git calls. */
  traceCtx?: TraceCtx
}

/**
 * `git diff`'s `index <sha>..<sha> <mode>` line embeds blob object ids. A
 * working-tree diff (`git diff HEAD`) always shows `0000000` on the
 * working-tree side (uncommitted content has no stored blob), while a
 * commit-to-commit diff (`git diff <shaA> <shaB>`) shows the real blob id on
 * both sides. Content-identical patches therefore differ textually on this
 * line alone; strip it before comparing so the comparison is exact on
 * everything that actually reflects file content (paths, modes, hunks).
 */
const INDEX_LINE_RE = /^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm

const normalizePatch = (patch: string): string =>
  patch.replace(INDEX_LINE_RE, 'index <redacted>').trim()

/**
 * Classify the dirt (if any) sitting on `input.repoRoot`'s working tree.
 *
 * Steps:
 *  1. `git status --porcelain --untracked-files=all` — empty ⇒ `clean`.
 *  2. Any `??` (untracked) entry ⇒ `operator-dirt`. A fast-forward `update-ref`
 *     plus working-tree re-sync never leaves behind untracked paths — only a
 *     genuine operator edit creates one.
 *  3. `lastSyncedSha` unknown, or not an ancestor of `headSha` ⇒
 *     `operator-dirt` (fail-safe: no basis to compute the inverse diff).
 *  4. Compare `git diff HEAD` (the observed dirt) against
 *     `git diff <headSha> <lastSyncedSha>` (the inverse of
 *     `lastSyncedSha..headSha`), normalised. Equal ⇒ `stale-tree-debris`;
 *     anything else, including the same inverse diff plus one extra changed
 *     file, ⇒ `operator-dirt`.
 */
export const attributeIntegrationDirt = async (
  input: AttributeIntegrationDirtInput,
): Promise<IntegrationDirtAttribution> => {
  const { repoRoot, lastSyncedSha, headSha, traceCtx } = input
  const git = resolveGitBin()

  const status = await execProbe(
    git,
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: repoRoot },
    traceCtx,
  )
  const statusOutput = status.stdout

  if (statusOutput.trim().length === 0) {
    return { kind: 'clean' }
  }

  const statusLines = statusOutput.split('\n').filter((l) => l.length > 0)

  // Untracked files never classify as stale-tree debris.
  if (statusLines.some((line) => line.slice(0, 2) === '??')) {
    return { kind: 'operator-dirt', statusOutput }
  }

  // Fail-safe: an unattributable last-synced SHA must never be treated as
  // resettable dirt.
  if (lastSyncedSha === null || lastSyncedSha.length === 0) {
    return { kind: 'operator-dirt', statusOutput }
  }

  const range = `${lastSyncedSha}..${headSha}`

  try {
    const ancestry = await execProbe(
      git,
      ['merge-base', '--is-ancestor', lastSyncedSha, headSha],
      { cwd: repoRoot },
      traceCtx,
    )
    if (ancestry.exitCode !== 0) {
      return { kind: 'operator-dirt', statusOutput }
    }

    const [observed, inverse] = await Promise.all([
      exec(git, ['diff', 'HEAD'], { cwd: repoRoot }, traceCtx),
      exec(git, ['diff', headSha, lastSyncedSha], { cwd: repoRoot }, traceCtx),
    ])

    if (normalizePatch(observed.stdout) === normalizePatch(inverse.stdout)) {
      return { kind: 'stale-tree-debris', range }
    }

    return { kind: 'operator-dirt', statusOutput }
  } catch {
    // Any git failure (bad ref, transient IO error, …) is unattributable —
    // fail safe to operator-dirt rather than risk resetting real work.
    return { kind: 'operator-dirt', statusOutput }
  }
}
