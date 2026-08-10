/**
 * Classify git porcelain v1 lines as orchestrator-owned vs user-owned.
 *
 * Mars writes its per-repo state exclusively under `.mars/` (postgres data,
 * the daemon config, the http port file, etc.). These files may appear in
 * `git status --porcelain` when they are tracked or untracked-but-not-ignored,
 * but they are owned by the orchestrator, not by the user. The setup step
 * uses this classifier to decide whether a dirty integration checkout can be
 * silently auto-stashed (all dirt is orchestrator-owned) or must park the task
 * (any user-owned dirt is present).
 *
 * Rule: a path beginning with `.mars/` is orchestrator-owned; everything else
 * is user-owned. The path is extracted from the porcelain line's destination
 * (after `->` for renames/copies).
 */

export interface ClassifyPorcelainLinesResult {
  /** Paths that begin with `.mars/` — safe to auto-stash and restore. */
  orchestratorOwned: string[]
  /** Any other paths — require operator action. */
  userOwned: string[]
}

/**
 * Classify an array of `git status --porcelain=v1` lines into orchestrator-
 * owned and user-owned paths.
 *
 * Empty lines are skipped. For rename/copy lines (`R  ORIG -> DEST`) the
 * destination path is what matters. Quoted paths (`"path with spaces"`) are
 * unquoted before the `.mars/` prefix check.
 */
export const classifyPorcelainLines = (
  lines: string[],
): ClassifyPorcelainLinesResult => {
  const orchestratorOwned: string[] = []
  const userOwned: string[] = []

  for (const line of lines) {
    if (line.length === 0) continue
    // Porcelain v1 format: "XY PATH" or "XY ORIG -> DEST" (rename/copy).
    // Columns 0-1 are the XY status flags; column 2 is a space separator.
    const raw = line.slice(3)
    const arrowIdx = raw.indexOf(' -> ')
    const pathRaw = arrowIdx >= 0 ? raw.slice(arrowIdx + 4) : raw
    const path = pathRaw.trim().replace(/^"|"$/g, '')

    if (path.startsWith('.mars/')) {
      orchestratorOwned.push(path)
    } else {
      userOwned.push(path)
    }
  }

  return { orchestratorOwned, userOwned }
}
