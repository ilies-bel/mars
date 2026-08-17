/**
 * Commit-message validation and repair for the merge gate.
 *
 * Validates that agent-produced commit subjects conform to the repo's
 * conventional-commit convention and fit within 72 characters. When a subject
 * exceeds the limit, it is truncated at the last word boundary and the overflow
 * is moved into the body — never silently split mid-word.
 *
 * The repair is applied to every commit on a task branch before fast-forward
 * into the integration branch, so malformed subjects are corrected at the gate
 * rather than landing permanently on `main`.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec, execProbe, resolveGitBin, repoRoot } from './internal'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SUBJECT_MAX_LEN = 72

/**
 * Conventional commit pattern: `type(scope): description` or `type: description`.
 * Scope is optional; a breaking-change marker `!` is allowed before the colon.
 */
const CONVENTIONAL_COMMIT_RE = /^[a-z]+(\([^)]+\))?!?: .+/

// ---------------------------------------------------------------------------
// Pure repair logic (no I/O — unit-testable without a real git repo)
// ---------------------------------------------------------------------------

export interface CommitMessageRepairResult {
  /** The final commit message (possibly identical to input when no repair was needed). */
  message: string
  /** True when at least one change was applied. */
  repaired: boolean
  /** Human-readable description of what was changed; absent when repaired=false. */
  reason?: string
}

/**
 * Truncates `s` at the last word boundary (space) at or before `maxLen`.
 *
 * If no space exists within the first `maxLen` characters, falls back to a
 * hard truncation at `maxLen` (edge case: a single token longer than the limit).
 * Never returns a string whose length exceeds `maxLen`.
 */
export function truncateAtWordBoundary(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  // Inspect one extra character so a space AT maxLen is found correctly.
  const window = s.slice(0, maxLen + 1)
  const lastSpace = window.lastIndexOf(' ')
  if (lastSpace <= 0) {
    // No space found — hard truncate (single long token).
    return s.slice(0, maxLen)
  }
  return s.slice(0, lastSpace)
}

/**
 * Inspects and, if necessary, repairs a raw commit message.
 *
 * Rules applied (in order):
 *  1. If the subject (first line) exceeds `SUBJECT_MAX_LEN`, truncate at the
 *     last word boundary and move the overflow to the top of the body.
 *  2. If a body exists but is not separated from the subject by a blank line,
 *     insert the blank line.
 *
 * The conventional-commit pattern is checked but NOT auto-repaired — pattern
 * violations are noted in `reason` so callers can log them, but the message
 * shape is not altered beyond the structural fixes above.
 *
 * Returns the original `rawMessage` unchanged (same reference) when no repair
 * is needed, so callers can use identity comparison to detect a no-op.
 */
export function repairCommitMessage(rawMessage: string): CommitMessageRepairResult {
  const raw = rawMessage.trimEnd()

  // Split subject (first line) from the rest.
  const firstNl = raw.indexOf('\n')
  const subject = firstNl === -1 ? raw : raw.slice(0, firstNl)
  const rawRest = firstNl === -1 ? '' : raw.slice(firstNl + 1)

  const reasons: string[] = []
  let newSubject = subject
  let overflow = ''

  // Rule 1: Subject too long — truncate at word boundary, overflow to body.
  if (subject.length > SUBJECT_MAX_LEN) {
    const truncated = truncateAtWordBoundary(subject, SUBJECT_MAX_LEN)
    overflow = subject.slice(truncated.length).trimStart()
    newSubject = truncated
    reasons.push(
      `subject was ${subject.length} chars (limit ${SUBJECT_MAX_LEN}); ` +
        `truncated to ${truncated.length} at word boundary`,
    )
  }

  // Note: conventional-commit pattern violation — logged but not auto-repaired.
  if (!CONVENTIONAL_COMMIT_RE.test(newSubject)) {
    reasons.push(`subject does not match conventional commit pattern (type(scope): description)`)
  }

  // Rule 2: Normalise blank-line separator between subject and body.
  //   - rawRest === ''          → no body, nothing to normalise.
  //   - rawRest starts with \n  → blank line already present, keep as-is.
  //   - rawRest has content but no leading \n → insert blank line.
  let normalizedBody = rawRest
  if (rawRest !== '' && !rawRest.startsWith('\n')) {
    normalizedBody = '\n' + rawRest
    reasons.push('inserted blank-line separator between subject and body')
  }

  // Prepend overflow to the body (before existing body content, after blank line).
  if (overflow) {
    if (normalizedBody) {
      // normalizedBody already starts with \n (blank line); prepend overflow
      // as an additional paragraph: \n<overflow>\n<existing body>
      normalizedBody = '\n' + overflow + normalizedBody
    } else {
      normalizedBody = '\n' + overflow
    }
  }

  const message = normalizedBody
    ? `${newSubject}\n${normalizedBody}`
    : newSubject

  // Return repaired:false when the message text is unchanged. A
  // pattern-violation note is informational (the comment above says "logged
  // but not auto-repaired") and must not trigger filter-branch: running it
  // with an unchanged message causes git to write a commit object without a
  // trailing newline (the parsed %B body is trimmed before writing), which
  // produces a different SHA even though the content is semantically identical.
  if (message === raw) {
    return { message: rawMessage, repaired: false }
  }

  return { message, repaired: true, reason: reasons.join('; ') }
}

// ---------------------------------------------------------------------------
// Git operation: rewrite non-conforming commit messages on a branch
// ---------------------------------------------------------------------------

export interface BranchRepairResult {
  /** Number of commits whose messages were rewritten. */
  repairedCount: number
  /** Per-commit details for each rewrite (oldest first). */
  repairs: Array<{ sha: string; reason: string }>
}

/**
 * Inspects every commit on `branch` that is ahead of `integrationBranch`.
 * For each commit whose subject is non-conforming, rewrites the commit
 * message using `git filter-branch --msg-filter`. When no commits need
 * repair, returns immediately without touching any refs.
 *
 * IMPORTANT: After a successful repair the branch tip SHA changes. Callers
 * must re-read `rev-parse <branch>` after this function returns to get the
 * new tip.
 *
 * @param branch           The task branch to inspect (checked out in worktreePath).
 * @param integrationBranch The integration branch (e.g. `main`).
 * @param worktreePath     The worktree where `branch` is checked out.
 */
export async function repairBranchCommitMessages(
  branch: string,
  integrationBranch: string,
  worktreePath: string,
): Promise<BranchRepairResult> {
  const git = resolveGitBin()
  const root = repoRoot()

  // Fetch commit SHAs and full messages between integrationBranch and branch.
  // %x1f = ASCII unit-separator; %x1e = ASCII record-separator — both are
  // safe delimiters because git commit messages never contain them.
  const { stdout: logOut } = await exec(
    git,
    ['log', '--format=%H%x1f%B%x1e', `${integrationBranch}..${branch}`],
    { cwd: root },
  )

  // Parse records: [ { sha, message } ]
  const commits = logOut
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const sepIdx = record.indexOf('\x1f')
      return {
        sha: record.slice(0, sepIdx).trim(),
        message: record.slice(sepIdx + 1),
      }
    })
    .filter((c) => c.sha.length === 40)

  if (commits.length === 0) {
    return { repairedCount: 0, repairs: [] }
  }

  // Determine which commits need repair.
  const repairs: Array<{ sha: string; reason: string; repairedMessage: string }> = []
  for (const { sha, message } of commits) {
    const result = repairCommitMessage(message)
    if (result.repaired) {
      repairs.push({ sha, reason: result.reason ?? 'repaired', repairedMessage: result.message })
    }
  }

  if (repairs.length === 0) {
    return { repairedCount: 0, repairs: [] }
  }

  // Write each repaired message to a temp file keyed by the original SHA.
  // filter-branch's --msg-filter shell snippet reads from these files via
  // the $GIT_COMMIT env var that filter-branch exports for each commit.
  const tmpDir = await mkdtemp(join(tmpdir(), 'mars-msg-repair-'))
  try {
    for (const { sha, repairedMessage } of repairs) {
      // Ensure the file ends with a newline: git commit objects always store
      // messages with a trailing newline, and filter-branch's --msg-filter
      // writes the output verbatim. Without the trailing newline the resulting
      // commit object differs from a normally-created one, causing an
      // unnecessary SHA change for otherwise-identical messages.
      const msgContent = repairedMessage.endsWith('\n') ? repairedMessage : repairedMessage + '\n'
      await writeFile(join(tmpDir, sha), msgContent, 'utf8')
    }

    const filterScript =
      `if [ -f "${tmpDir}/$GIT_COMMIT" ]; then cat "${tmpDir}/$GIT_COMMIT"; else cat; fi`

    // Run filter-branch against the commits on branch since integrationBranch.
    // -f: overwrite any pre-existing refs/original backup.
    await exec(
      git,
      [
        'filter-branch',
        '-f',
        '--msg-filter',
        filterScript,
        `${integrationBranch}..HEAD`,
      ],
      { cwd: worktreePath },
    )

    // Clean up the backup ref that filter-branch creates.
    await execProbe(
      git,
      ['update-ref', '-d', `refs/original/refs/heads/${branch}`],
      { cwd: worktreePath },
    ).catch(() => {
      // Best-effort: the ref may not exist (e.g. different worktree setups).
    })

    console.log(
      `[merge:commit-repair] rewrote ${repairs.length} commit message(s) on branch ${branch}:`,
    )
    for (const { sha, reason } of repairs) {
      console.log(`  ${sha.slice(0, 9)}: ${reason}`)
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  return {
    repairedCount: repairs.length,
    repairs: repairs.map(({ sha, reason }) => ({ sha, reason })),
  }
}
