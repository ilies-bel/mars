/**
 * Durable record of the sha the PRIMARY integration checkout (the main
 * repo working tree, not a task worktree) was last reset to by a merge.
 *
 * Merges advance `refs/heads/<integrationBranch>` with a working-tree-free
 * `git update-ref`, then — only when the primary checkout happens to be on
 * that branch — re-sync its working tree with `git reset --hard` (see
 * `mergeBranch`'s Step 3 in `merge.ts`). That re-sync can be interrupted by a
 * crash or a concurrent process. Without an independent record of what sha
 * the working tree was LAST KNOWN to match, a later process inspecting a
 * dirty or unexpected tree has no way to tell "stale re-sync debris from a
 * merge that landed fine" apart from "genuine, unrelated dirt" — it has to
 * guess. Recording the sha here turns that guess into a lookup: read it back,
 * diff the tree against it, and the question answers itself.
 *
 * This module only ever touches the filesystem — no git subprocess calls —
 * so every function here takes an explicit repo root and is trivially
 * testable without a real git checkout.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { repoRoot as defaultRepoRoot } from './internal'

/** Path, relative to the repo root, the last-synced sha is recorded at. */
export const LAST_SYNCED_SHA_PATH = '.mars/last-synced-sha'

/** A git commit sha is exactly 40 lowercase hex characters. */
const SHA_PATTERN = /^[0-9a-f]{40}$/

const resolveFilePath = (repoRoot?: string): string =>
  resolve(repoRoot ?? defaultRepoRoot(), LAST_SYNCED_SHA_PATH)

/**
 * Read back the sha the integration checkout was last synced to.
 *
 * Never throws: an absent file (nothing recorded yet), an empty file (an
 * interrupted write that never reached the atomic rename), or contents that
 * are not a 40-hex sha (corruption, a stray edit) all resolve to `null`
 * rather than raising — callers treat "unknown" and "unrecorded" alike.
 */
export const readLastSyncedSha = (repoRoot?: string): string | null => {
  const path = resolveFilePath(repoRoot)
  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const sha = contents.trim()
  return SHA_PATTERN.test(sha) ? sha : null
}

/**
 * Record `sha` as the integration checkout's last-synced HEAD.
 *
 * Writes to a sibling `.tmp` file first, then `renameSync`s it into place —
 * a rename within the same directory is atomic on every filesystem git
 * itself relies on, so a process killed mid-write can only ever leave a
 * stray `.tmp` file behind, never a truncated `LAST_SYNCED_SHA_PATH`.
 */
export const writeLastSyncedSha = (sha: string, repoRoot?: string): void => {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`writeLastSyncedSha: '${sha}' is not a 40-character hex sha`)
  }
  const path = resolveFilePath(repoRoot)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, `${sha}\n`, 'utf8')
  renameSync(tmpPath, path)
}
