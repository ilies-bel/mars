/**
 * WIP-shaped guard for the dirty-main auto-salvage chore.
 *
 * When the orchestrator's setup pre-flight detects uncommitted tracked changes
 * on the merge target, the salvage chore auto-commits those changes so queued
 * tasks can proceed. This module guards that auto-commit: if any of the dirty
 * files live under a tests directory AND their diff introduces WIP markers
 * (a TODO comment or a skipped-test pattern), the salvage is blocked — silently
 * landing half-finished test edits on the merge target would be worse than the
 * original dirty-main condition.
 *
 * On a guard trip the caller skips spawning the chore and falls through to the
 * existing blocked-plus-actionQueue behaviour so an operator can resolve the WIP
 * manually.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Matches file paths that live under a conventional test directory.
 * Only path segments that are *exactly* `__tests__`, `test`, or `tests`
 * count — e.g. `testutils` does not trip the guard.
 */
const TEST_DIR_RE = /(?:^|\/)(?:__tests__|tests?)(?:\/|$)/

/**
 * WIP marker patterns applied to *added* diff lines (lines beginning with `+`
 * but not `++`, which is the diff-header form `+++ b/file`).
 *
 * Only additions are checked: removing a TODO comment or a `.skip` call is
 * intentional cleanup and must not block the salvage.
 */
const WIP_PATTERNS: readonly { re: RegExp; label: string }[] = [
  { re: /^\+(?!\+).*\/\/\s*TODO\b/m, label: 'TODO comment' },
  { re: /^\+(?!\+).*\/\*\s*TODO\b/m, label: 'TODO comment' },
  { re: /^\+(?!\+).*\bit\.skip\s*\(/m, label: 'skipped test (it.skip)' },
  { re: /^\+(?!\+).*\btest\.skip\s*\(/m, label: 'skipped test (test.skip)' },
  { re: /^\+(?!\+).*\bdescribe\.skip\s*\(/m, label: 'skipped test (describe.skip)' },
  { re: /^\+(?!\+).*\bxit\s*\(/m, label: 'skipped test (xit)' },
  { re: /^\+(?!\+).*\bxdescribe\s*\(/m, label: 'skipped test (xdescribe)' },
  { re: /^\+(?!\+).*\bit\.todo\s*\(/m, label: 'skipped test (it.todo)' },
  { re: /^\+(?!\+).*\btest\.todo\s*\(/m, label: 'skipped test (test.todo)' },
]

export interface WipHit {
  /** Repo-relative path of the file that tripped the guard. */
  filePath: string
  /** Human-readable label describing the marker type (e.g. "TODO comment"). */
  label: string
  /** The raw matched diff line (trimmed). */
  line: string
}

/**
 * Pure detection function: checks whether a git unified diff for a file that
 * lives under a tests directory introduces any WIP markers.
 *
 * Returns the first `WipHit` found, or `null` when the path is not under a
 * tests directory or the diff contains no WIP markers.
 *
 * @param filePath - Repo-relative path (as produced by `git status --porcelain`
 *   after stripping the XY status prefix).
 * @param diff - Unified diff output from `git diff HEAD -- <file>`.
 */
export function detectWipMarkerInTestDiff(
  filePath: string,
  diff: string,
): WipHit | null {
  if (!TEST_DIR_RE.test(filePath)) return null
  for (const { re, label } of WIP_PATTERNS) {
    const m = re.exec(diff)
    if (m) {
      return { filePath, label, line: m[0].trimStart() }
    }
  }
  return null
}

export type WipScanResult = { blocked: false } | { blocked: true; hit: WipHit }

// ---------------------------------------------------------------------------
// Secret-path guard
// ---------------------------------------------------------------------------

/**
 * Identifies a file path that belongs to a directory the salvage chore must
 * never auto-commit.
 */
export interface SecretPathHit {
  /** Repo-relative path that tripped the guard. */
  filePath: string
  /** Human-readable reason (e.g. "per-repo state directory"). */
  reason: string
}

/**
 * Checks whether a single repo-relative file path belongs to a directory that
 * must never be auto-committed — by the dirty-main salvage chore or
 * by the code step's coder-left-uncommitted auto-commit net
 * (`autoCommitWorktreeIfDeterministic`), which shares this guard:
 *
 * - Per-repo state directory: any path that is exactly `.mars` or starts
 *   with `.mars/`.
 * - Dependency directories: any path with a `node_modules` segment.
 *
 * `node_modules/` and `/.mars/` are gitignored in this repo, so `git add -A`
 * already skips them; the guard is the belt to that braces — a consumer repo
 * with a thinner `.gitignore`, or a path force-added by an agent, must not be
 * able to sweep dependencies or per-repo state into an auto-commit.
 *
 * Returns a `SecretPathHit` when the path matches, or `null` when safe.
 */
export function checkSecretPath(filePath: string): SecretPathHit | null {
  if (filePath === '.mars' || filePath.startsWith('.mars/')) {
    return { filePath, reason: 'per-repo state directory' }
  }

  if (
    filePath === 'node_modules' ||
    filePath.startsWith('node_modules/') ||
    filePath.includes('/node_modules/') ||
    filePath.endsWith('/node_modules')
  ) {
    return { filePath, reason: 'dependency directory' }
  }

  return null
}

/**
 * Combined guard result returned by {@link scanDirtyFilesForGuards}.
 */
export type GuardResult =
  | { blocked: false }
  | { blocked: true; kind: 'secret-path'; hit: SecretPathHit }
  | { blocked: true; kind: 'wip'; hit: WipHit }

/**
 * Combined salvage guard: checks ALL dirty paths for protected directory shapes
 * first (pure, no git I/O), then checks test-directory files for WIP markers.
 *
 * The guard is **all-or-nothing**: if any path matches the protected-directory
 * guard, `{ blocked: true, kind: 'secret-path' }` is returned immediately
 * without fetching any git diffs. The caller must treat any `blocked: true`
 * result as "skip the salvage chore entirely — commit nothing".
 *
 * Returns `{ blocked: false }` when the full dirty tree is safe to
 * auto-commit.
 */
export async function scanDirtyFilesForGuards(
  repoRoot: string,
  dirtyLines: string[],
): Promise<GuardResult> {
  // First pass: pure path-shape guard — no git I/O needed.
  for (const line of dirtyLines) {
    const raw = line.slice(3).trim()
    const arrowIdx = raw.indexOf(' -> ')
    const filePath = arrowIdx >= 0 ? raw.slice(arrowIdx + 4) : raw

    const secretHit = checkSecretPath(filePath)
    if (secretHit) return { blocked: true, kind: 'secret-path', hit: secretHit }
  }

  // Second pass: WIP-marker guard for test files (async, needs git diff).
  const wipResult = await scanDirtyTestsForWip(repoRoot, dirtyLines)
  if (wipResult.blocked) {
    return { blocked: true, kind: 'wip', hit: wipResult.hit }
  }

  return { blocked: false }
}

// ---------------------------------------------------------------------------
// WIP scan (kept below the secret-path guard so scanDirtyFilesForGuards can
// reference scanDirtyTestsForWip; callers importing both still work fine)
// ---------------------------------------------------------------------------

/**
 * Scans dirty tracked files (as reported by
 * `git status --porcelain --untracked-files=no`) for WIP markers in files
 * under test directories.
 *
 * For each dirty file path that lives under `__tests__/`, `test/`, or
 * `tests/`, fetches the `git diff HEAD` output for that file and checks for
 * TODO comments or skipped-test patterns in the added lines.
 *
 * Returns `{ blocked: false }` when no WIP is detected (salvage may proceed).
 * Returns `{ blocked: true, hit }` on the first WIP marker found (salvage must
 * be skipped; the caller falls through to blocked-plus-actionQueue behaviour).
 *
 * Git/IO failures propagate to the caller; the setup pre-flight wraps this
 * call in a best-effort try/catch so transient git errors do not permanently
 * block the task.
 */
export async function scanDirtyTestsForWip(
  repoRoot: string,
  dirtyLines: string[],
): Promise<WipScanResult> {
  for (const line of dirtyLines) {
    const raw = line.slice(3).trim()
    // Handle git --porcelain rename format: "old_path -> new_path"
    const arrowIdx = raw.indexOf(' -> ')
    const filePath = arrowIdx >= 0 ? raw.slice(arrowIdx + 4) : raw

    if (!TEST_DIR_RE.test(filePath)) continue

    const { stdout: diff } = await execFileAsync(
      'git',
      ['diff', 'HEAD', '--', filePath],
      { cwd: repoRoot },
    )
    const hit = detectWipMarkerInTestDiff(filePath, diff)
    if (hit) return { blocked: true, hit }
  }
  return { blocked: false }
}
