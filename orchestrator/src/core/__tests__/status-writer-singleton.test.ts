import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

/**
 * Architecture guard: the literal `UPDATE tasks SET status` (status as the
 * FIRST column after SET) must appear in exactly one non-test production
 * source file — orchestrator/src/core/arc.ts — and within that file it
 * must be confined to the body of `Arc.setTaskStatus`, the single-writer
 * chokepoint (PRD 12fdef39 / ADR-0030 / ADR-0052 sole-writer).
 *
 * ADR-0052 relocation: `setTaskStatus` and its `mapStatusToEvent` helper moved
 * out of queue.ts into the Arc aggregate (`Arc.setTaskStatus`). The canonical
 * status-bearing `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`
 * string and its four `task.completed/dropped/failed/queued` emit branches now
 * live in core/arc.ts. (The eventual ADR-0052 Enforce step replaces this guard
 * with a stricter `arc-sole-writer.test.ts`; until then this guard tracks the
 * relocated home.)
 *
 * Any code path that writes `tasks.status` with `status` as the first column
 * after SET, outside the chokepoint, would bypass the in-transaction
 * lifecycle-event publish and leave Action-queue rows stale. A regex scan of
 * the source tree catches the antipattern before it reaches review.
 *
 * Design note — "first column" convention:
 *   Functions that need a conditional WHERE clause (e.g. `unblockTask`,
 *   `promoteDraftToTriaging`, `Arc.promoteDraftToQueued`) write
 *   `SET updated_at = ?, status = ...` (updated_at first). This exempts them
 *   from the scan; they already publish their lifecycle events atomically in
 *   the same transaction. The canonical `Arc.setTaskStatus` write has `status`
 *   first, matching the pattern below. The column-patch primitive
 *   `Arc.applyStatusWrite` builds `UPDATE tasks SET ${fields}` from a template
 *   (no literal `status` token), so it is also not flagged.
 *
 * Two assertions:
 *   1. /UPDATE\s+tasks\s+SET\s+status/i matches in exactly one non-test
 *      production source file: core/arc.ts.
 *   2. Every occurrence in arc.ts falls within the body of `Arc.setTaskStatus`
 *      (between `static async setTaskStatus` and the next top-level
 *      method/`export`).
 */

const SRC_ROOT = resolve(__dirname, '..', '..', '..', 'src')
const STATUS_WRITE = /UPDATE\s+tasks\s+SET\s+status/i
const ALLOWED = ['core', 'arc.ts'].join(sep)

const SKIP_DIRS = new Set(['node_modules', '__tests__', '.git', 'dist', 'build'])

const walk = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = resolve(dir, name)
    const s = statSync(full)
    if (s.isDirectory()) {
      out.push(...walk(full))
    } else if (s.isFile() && /\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      // Test files legitimately embed SQL strings (e.g. direct DB helpers in
      // test helpers). Only production source is guarded.
      out.push(full)
    }
  }
  return out
}

/**
 * Strip line and block comments so a doc comment that QUOTES the antipattern
 * (e.g. "call before an `UPDATE tasks SET status = 'blocked'` write") does
 * not trigger a false positive.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

describe('architecture: UPDATE tasks SET status is confined to setTaskStatus in queue.ts', () => {
  it('scanner regex matches known raw status writes but not the exempt form', () => {
    // Meta-guard: a regex typo would make all other assertions vacuously pass.
    // Pin the pattern against representative SQL to rule out the silent-pass risk.
    expect(STATUS_WRITE.test(`UPDATE tasks SET status = 'done' WHERE id = ?`)).toBe(true)
    expect(STATUS_WRITE.test("UPDATE tasks\n  SET status = ?")).toBe(true)
    expect(STATUS_WRITE.test('UPDATE tasks SET status=? WHERE id=?')).toBe(true)

    // Unrelated column — must NOT flag.
    expect(STATUS_WRITE.test(`UPDATE tasks SET tag = 'coder' WHERE tag IS NULL`)).toBe(false)

    // The "exempt" form used by functions that need conditional WHERE clauses:
    // updated_at comes first, status second. These functions already publish
    // events in the same transaction, so the scan intentionally skips them.
    expect(STATUS_WRITE.test(`UPDATE tasks SET updated_at = ?, status = 'failed'`)).toBe(false)
    expect(STATUS_WRITE.test("UPDATE tasks\n  SET updated_at = ?,\n      status = 'queued'")).toBe(
      false,
    )
  })

  it('exactly one non-test production file carries the pattern: core/queue.ts', () => {
    const files = walk(SRC_ROOT)
    const matches = files
      .filter((f) => STATUS_WRITE.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC_ROOT, f))

    expect(
      matches,
      `these files contain UPDATE tasks SET status outside the Arc.setTaskStatus ` +
        `chokepoint — route them through Arc.setTaskStatus(taskId, newStatus) in ` +
        `core/arc.ts, or put updated_at before status in the SET clause if a ` +
        `conditional WHERE is required:\n` +
        matches.filter((r) => r !== ALLOWED).join('\n'),
    ).toEqual([ALLOWED])
  })

  it('all STATUS_WRITE occurrences in arc.ts fall within the Arc.setTaskStatus method body', () => {
    const arcPath = resolve(SRC_ROOT, ...ALLOWED.split(sep))
    const src = stripComments(readFileSync(arcPath, 'utf8'))

    const startMarker = 'static async setTaskStatus'
    const startIdx = src.indexOf(startMarker)
    expect(startIdx, 'Arc.setTaskStatus not found in arc.ts').toBeGreaterThan(-1)

    // Window: from the start of Arc.setTaskStatus to the start of the next
    // class member. The next member after setTaskStatus is the `transition`
    // method; class members are declared as `\n  async <name>(` /
    // `\n  static <name>(` (two-space indent), so the next such declaration
    // closes the window.
    const afterStart = startIdx + startMarker.length
    const nextMemberIdx = (() => {
      const memberPattern = /\n {2}(?:async|static|private)\s/g
      memberPattern.lastIndex = afterStart
      const mm = memberPattern.exec(src)
      return mm ? mm.index : -1
    })()
    const windowEnd = nextMemberIdx >= 0 ? nextMemberIdx : src.length

    // Collect every STATUS_WRITE match position in the full source, then
    // assert ALL of them fall inside [startIdx, windowEnd).
    const pattern = new RegExp(STATUS_WRITE.source, STATUS_WRITE.flags + 'g')
    const outsideBody: number[] = []
    let m: RegExpExecArray | null
    while ((m = pattern.exec(src)) !== null) {
      if (m.index < startIdx || m.index >= windowEnd) {
        outsideBody.push(m.index)
      }
    }

    expect(
      outsideBody,
      `found ${outsideBody.length} STATUS_WRITE occurrence(s) in arc.ts outside ` +
        `the Arc.setTaskStatus body (character offsets: ${outsideBody.join(', ')}) — ` +
        `move them inside Arc.setTaskStatus or switch to the exempt form ` +
        `(SET updated_at = ?, status = ...)`,
    ).toEqual([])
  })
})
