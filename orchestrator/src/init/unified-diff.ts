/**
 * A tiny, dependency-free unified-diff generator (hand-rolled line-based LCS).
 *
 * `mars update` uses this to show the operator how the bundled workflow template
 * has diverged from their hand-edited copy before prompting accept/skip. The
 * `diff` npm dep is intentionally NOT introduced (none is present in
 * package.json and ADR-0057's merge guidance only needs a readable diff).
 *
 * Output mirrors `diff -u`: a `--- <path>` / `+++ <path>` header, then one
 * `@@ -a,b +c,d @@` hunk per contiguous change region, with ` `/`-`/`+`
 * line prefixes. Returns the empty string when the two inputs are identical so
 * callers can cheaply test "did anything change?".
 */

interface DiffOp {
  kind: 'equal' | 'del' | 'add'
  line: string
}

/** Longest-common-subsequence line diff (classic DP, fine for source files). */
const diffLines = (a: readonly string[], b: readonly string[]): DiffOp[] => {
  const n = a.length
  const m = b.length
  // lcs[i][j] = LCS length of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'equal', line: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i]! })
      i++
    } else {
      ops.push({ kind: 'add', line: b[j]! })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++]! })
  while (j < m) ops.push({ kind: 'add', line: b[j++]! })
  return ops
}

/** Split into lines, dropping a single trailing empty line from a final '\n'. */
const splitLines = (content: string): string[] => {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

const CONTEXT = 3

/**
 * Produce a `diff -u`-style unified diff of `oldContent` → `newContent`,
 * labelled with `filePath`. Returns '' when the inputs are byte-identical.
 */
export const unifiedDiff = (
  oldContent: string,
  newContent: string,
  filePath: string,
): string => {
  if (oldContent === newContent) return ''

  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  const ops = diffLines(oldLines, newLines)

  // Group ops into hunks: a change region plus up to CONTEXT equal lines on
  // each side. Consecutive change regions within 2*CONTEXT equal lines merge.
  const hunks: Hunk[] = []
  let oldLine = 1
  let newLine = 1
  let idx = 0

  while (idx < ops.length) {
    // Skip leading equal lines until the next change.
    while (idx < ops.length && ops[idx]!.kind === 'equal') {
      oldLine++
      newLine++
      idx++
    }
    if (idx >= ops.length) break

    // Back up CONTEXT lines of leading context.
    const equalRun: DiffOp[] = []
    let back = idx - 1
    while (back >= 0 && ops[back]!.kind === 'equal' && equalRun.length < CONTEXT) {
      equalRun.unshift(ops[back]!)
      back--
    }

    const hunkLines: string[] = []
    let oldStart = oldLine - equalRun.length
    let newStart = newLine - equalRun.length
    let oldCount = 0
    let newCount = 0

    for (const eq of equalRun) {
      hunkLines.push(` ${eq.line}`)
      oldCount++
      newCount++
    }

    // Consume the change region, allowing small equal gaps (< 2*CONTEXT) to be
    // absorbed so adjacent edits land in one hunk.
    let trailingEqual = 0
    while (idx < ops.length) {
      const op = ops[idx]!
      if (op.kind === 'equal') {
        // Look ahead: is there another change within CONTEXT lines?
        let lookahead = idx
        let equalSpan = 0
        while (
          lookahead < ops.length &&
          ops[lookahead]!.kind === 'equal'
        ) {
          equalSpan++
          lookahead++
        }
        if (lookahead < ops.length && equalSpan <= CONTEXT * 2) {
          // Absorb the equal gap into this hunk.
          for (let k = 0; k < equalSpan; k++) {
            hunkLines.push(` ${ops[idx]!.line}`)
            oldCount++
            newCount++
            oldLine++
            newLine++
            idx++
          }
          continue
        }
        // Emit up to CONTEXT trailing equal lines, then close the hunk.
        for (let k = 0; k < Math.min(CONTEXT, equalSpan); k++) {
          hunkLines.push(` ${ops[idx]!.line}`)
          oldCount++
          newCount++
          oldLine++
          newLine++
          idx++
          trailingEqual++
        }
        break
      }
      if (op.kind === 'del') {
        hunkLines.push(`-${op.line}`)
        oldCount++
        oldLine++
      } else {
        hunkLines.push(`+${op.line}`)
        newCount++
        newLine++
      }
      idx++
    }

    if (oldStart < 1) oldStart = 1
    if (newStart < 1) newStart = 1
    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines })
    void trailingEqual
  }

  const header = `--- ${filePath}\n+++ ${filePath}\n`
  const body = hunks
    .map((h) => {
      const range = `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`
      return [range, ...h.lines].join('\n')
    })
    .join('\n')
  return `${header}${body}\n`
}
