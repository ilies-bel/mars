import { taskHash } from './routing'

// ---------------------------------------------------------------------------
// Protected-range detection
// ---------------------------------------------------------------------------

type Range = readonly [number, number]

/** Run a global RegExp over text and yield all match objects. */
function* execAll(pattern: RegExp, text: string): Generator<RegExpExecArray> {
  pattern.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    yield m
  }
}

/**
 * Return ranges of `text` that must not be linkified:
 *   - fenced code blocks (``` ... ```)
 *   - inline code spans (` ... `)
 *   - existing markdown links ([...](...))`
 */
function protectedRanges(text: string): Range[] {
  const ranges: Range[] = []

  const push = (m: RegExpExecArray) =>
    ranges.push([m.index, m.index + m[0].length])

  // Fenced code blocks — ``` optional-lang \n … \n ```
  for (const m of execAll(/^```[^\n]*\n[\s\S]*?^```[^\n]*/gm, text)) push(m)

  // Inline code spans
  for (const m of execAll(/`[^`\n]+`/g, text)) push(m)

  // Existing markdown links [text](href)
  for (const m of execAll(/\[(?:[^\]]*)\]\((?:[^)]*)\)/g, text)) push(m)

  return ranges
}

function isProtected(start: number, end: number, ranges: Range[]): boolean {
  return ranges.some(([s, e]) => start >= s && end <= e)
}

// ---------------------------------------------------------------------------
// Task ID detection
// ---------------------------------------------------------------------------

interface Match {
  start: number
  end: number
  id: string
}

function collectMatches(text: string, ranges: Range[]): Match[] {
  const matches: Match[] = []

  const add = (pattern: RegExp) => {
    for (const m of execAll(pattern, text)) {
      const start = m.index
      const end = m.index + m[0].length
      if (!isProtected(start, end, ranges)) {
        matches.push({ start, end, id: m[0] })
      }
    }
  }

  // Prefixed IDs first so they win the overlap check over bare 8-char IDs
  add(/\b(?:mars|fix|task|recovery)-[0-9a-f]{6,8}\b/g)
  // Bare 8-char hex IDs
  add(/\b[0-9a-f]{8}\b/g)

  return matches
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a markdown string and convert task-ID tokens into markdown links that
 * open the `TaskDetailDrawer` via the app's hash router.
 *
 * Recognised forms:
 *   - prefixed: `mars-`, `fix-`, `task-`, `recovery-` followed by 6–8 hex chars
 *   - bare:     exactly 8 hex chars surrounded by word boundaries
 *
 * IDs inside backtick code spans, fenced code blocks, or existing `[…](…)`
 * links are left untouched to prevent double-linkification.
 */
export function linkifyTaskIds(text: string): string {
  const ranges = protectedRanges(text)
  const all = collectMatches(text, ranges)

  if (all.length === 0) return text

  // Sort by position ascending; on tie keep the longer match (prefixed > bare)
  all.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))

  // Discard overlapping matches — once an earlier/longer match is accepted,
  // any later match that shares any character is skipped.
  const accepted: Match[] = []
  for (const m of all) {
    if (!accepted.some(a => m.start < a.end && m.end > a.start)) {
      accepted.push(m)
    }
  }

  // Apply replacements in reverse position order so earlier offsets stay valid
  accepted.sort((a, b) => b.start - a.start)

  let result = text
  for (const { start, end, id } of accepted) {
    const href = taskHash(id, 'chat')
    result = result.slice(0, start) + `[${id}](${href})` + result.slice(end)
  }

  return result
}
