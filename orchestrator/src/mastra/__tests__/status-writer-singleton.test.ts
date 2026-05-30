import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

/**
 * Architecture guard: the literal `UPDATE tasks SET status` (status as the
 * FIRST column after SET) must appear in exactly one non-test production
 * source file — orchestrator/src/mastra/queue.ts — and within that file it
 * must be confined to the body of `setTaskStatus`, the single-writer
 * chokepoint (PRD 12fdef39 / ADR-0030).
 *
 * Any code path that writes `tasks.status` with `status` as the first column
 * after SET, outside the chokepoint, would bypass the in-transaction
 * lifecycle-event publish and leave Action-queue rows stale. A regex scan of
 * the source tree catches the antipattern before it reaches review.
 *
 * Design note — "first column" convention:
 *   Functions that need a conditional WHERE clause (e.g. `unblockTask`,
 *   `promoteDraftToTriaging`) write `SET updated_at = ?, status = ...`
 *   (updated_at first). This exempts them from the scan; they already publish
 *   their lifecycle events atomically in the same transaction. The canonical
 *   `setTaskStatus` write has `status` first, matching the pattern below.
 *
 * Two assertions:
 *   1. /UPDATE\s+tasks\s+SET\s+status/i matches in exactly one non-test
 *      production source file: mastra/queue.ts.
 *   2. Every occurrence in queue.ts falls within the body of `setTaskStatus`
 *      (between `export async function setTaskStatus` and the next top-level
 *      `export`).
 */

const SRC_ROOT = resolve(__dirname, '..', '..', '..', 'src')
const STATUS_WRITE = /UPDATE\s+tasks\s+SET\s+status/i
const ALLOWED = ['mastra', 'queue.ts'].join(sep)

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

  it('exactly one non-test production file carries the pattern: mastra/queue.ts', () => {
    const files = walk(SRC_ROOT)
    const matches = files
      .filter((f) => STATUS_WRITE.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC_ROOT, f))

    expect(
      matches,
      `these files contain UPDATE tasks SET status outside the setTaskStatus ` +
        `chokepoint — route them through setTaskStatus(taskId, newStatus) in ` +
        `queue.ts, or put updated_at before status in the SET clause if a ` +
        `conditional WHERE is required:\n` +
        matches.filter((r) => r !== ALLOWED).join('\n'),
    ).toEqual([ALLOWED])
  })

  it('all STATUS_WRITE occurrences in queue.ts fall within the setTaskStatus function body', () => {
    const queuePath = resolve(SRC_ROOT, ...ALLOWED.split(sep))
    const src = stripComments(readFileSync(queuePath, 'utf8'))

    const startMarker = 'export async function setTaskStatus'
    const startIdx = src.indexOf(startMarker)
    expect(startIdx, 'setTaskStatus not found in queue.ts').toBeGreaterThan(-1)

    // Window: from the start of setTaskStatus to the next top-level export.
    const afterStart = startIdx + startMarker.length
    const nextExportIdx = src.indexOf('\nexport ', afterStart)
    const windowEnd = nextExportIdx >= 0 ? nextExportIdx : src.length

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
      `found ${outsideBody.length} STATUS_WRITE occurrence(s) in queue.ts outside ` +
        `the setTaskStatus body (character offsets: ${outsideBody.join(', ')}) — ` +
        `move them inside setTaskStatus or switch to the exempt form ` +
        `(SET updated_at = ?, status = ...)`,
    ).toEqual([])
  })
})
