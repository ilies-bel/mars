/**
 * Minimal unified-diff parser for rendering per-file hunks in the UI.
 *
 * Parses a multi-file unified diff (as produced by `git diff`) into a list of
 * file sections, each containing its raw header lines plus parsed hunks.
 * The parser is intentionally minimal — it handles the subset git produces:
 *
 *   diff --git a/foo.ts b/foo.ts
 *   index ...
 *   --- a/foo.ts
 *   +++ b/foo.ts
 *   @@ -1,5 +1,10 @@
 *   [context / added / removed lines]
 *
 * Binary-file diffs are captured as a section with no hunks.
 */

/** One line in a diff hunk, tagged by its role. */
export interface DiffLine {
  kind: 'context' | 'added' | 'removed' | 'no-newline'
  text: string
}

/** One `@@` hunk in a file section. */
export interface DiffHunk {
  /** The raw `@@ ... @@` header line, including any trailing context. */
  header: string
  lines: DiffLine[]
}

/** One file-level section of the diff (corresponds to one `diff --git` block). */
export interface DiffFile {
  /**
   * The file path extracted from the `+++ b/<path>` line.
   * Falls back to the `--- a/<path>` line for deletions.
   * Empty string when neither line is present (should not happen with git).
   */
  path: string
  /** All header lines before the first `@@` (or to the end for binary diffs). */
  header: string[]
  hunks: DiffHunk[]
  /** True when git reported this as a binary file. */
  isBinary: boolean
}

/**
 * Split a unified diff string into per-file sections with parsed hunks.
 *
 * Handles multi-file diffs cleanly. Does NOT validate the diff format —
 * malformed lines are treated as context lines.
 *
 * @param patch - The raw unified diff text (e.g. from `git diff`).
 * @returns An array of {@link DiffFile} objects, one per changed file.
 */
export function parseDiff(patch: string): DiffFile[] {
  const lines = patch.split('\n')
  const files: DiffFile[] = []

  let current: DiffFile | null = null
  let currentHunk: DiffHunk | null = null

  const pushHunk = () => {
    if (currentHunk && current) {
      current.hunks.push(currentHunk)
      currentHunk = null
    }
  }

  const pushFile = () => {
    pushHunk()
    if (current) files.push(current)
    current = null
  }

  for (const raw of lines) {
    // New file block starts with "diff --git"
    if (raw.startsWith('diff --git ')) {
      pushFile()
      current = { path: '', header: [raw], hunks: [], isBinary: false }
      continue
    }

    if (!current) {
      // Lines before any "diff --git" — skip (e.g. index header for combined diffs).
      continue
    }

    // Detect binary files.
    if (raw.startsWith('Binary files ')) {
      current.isBinary = true
      current.header.push(raw)
      continue
    }

    // Extract path from +++ or --- lines (before the first @@).
    if (currentHunk === null) {
      if (raw.startsWith('+++ ')) {
        const pathStr = raw.slice(4)
        // Strip "b/" prefix that git adds. Do NOT override with /dev/null
        // (that is what git writes for deleted files; the --- line already set
        // the correct path for those).
        if (pathStr !== '/dev/null') {
          current.path = pathStr.startsWith('b/') ? pathStr.slice(2) : pathStr
        }
        current.header.push(raw)
        continue
      }
      if (raw.startsWith('--- ')) {
        const pathStr = raw.slice(4)
        // Use --- a/<path> as a fallback path (set before +++ is processed).
        // For new files, --- is "/dev/null" — skip it.
        if (!current.path) {
          const stripped = pathStr.startsWith('a/') ? pathStr.slice(2) : pathStr
          if (stripped !== '/dev/null') current.path = stripped
        }
        current.header.push(raw)
        continue
      }
      if (raw.startsWith('@@ ')) {
        // Start of first hunk — fall through to hunk handling below.
      } else {
        current.header.push(raw)
        continue
      }
    }

    // Hunk header line.
    if (raw.startsWith('@@ ')) {
      pushHunk()
      currentHunk = { header: raw, lines: [] }
      continue
    }

    // Hunk body lines.
    if (currentHunk) {
      if (raw.startsWith('+')) {
        currentHunk.lines.push({ kind: 'added', text: raw.slice(1) })
      } else if (raw.startsWith('-')) {
        currentHunk.lines.push({ kind: 'removed', text: raw.slice(1) })
      } else if (raw === '\\ No newline at end of file') {
        currentHunk.lines.push({ kind: 'no-newline', text: raw })
      } else {
        // Context line (starts with space, or is the empty last line of a hunk).
        currentHunk.lines.push({ kind: 'context', text: raw.slice(1) })
      }
      continue
    }

    // Unexpected line outside a hunk (e.g. extended headers). Treat as header.
    current.header.push(raw)
  }

  pushFile()
  return files
}

/**
 * Compute total addition and deletion counts across all hunks for a DiffFile.
 * Returns `{ additions: 0, deletions: 0 }` for binary files or files without hunks.
 */
export function diffFileCounts(file: DiffFile): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'added') additions++
      else if (line.kind === 'removed') deletions++
    }
  }
  return { additions, deletions }
}
