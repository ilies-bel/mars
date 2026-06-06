import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

/**
 * Architecture guard for the single-writer-emit seam (PRD 12fdef39 / ADR
 * for the outbox-driven Invalidator).
 *
 * Every code path that changes `tasks.status` or deletes a `tasks` row must
 * emit its lifecycle event into the outbox in the SAME transaction as the
 * write, so the Invalidator (a durable subscriber) reliably clears the
 * task's Action-queue rows. To make that structurally enforceable — rather
 * than convention-policed — we keep a tiny allowlist of files allowed to
 * write `tasks.status` / delete `tasks`; every other file must route through
 * one of them. A new raw status write anywhere else fails this test.
 *
 * The pattern is intentionally narrowed to STATUS writes and row DELETEs:
 * the broad "any write to tasks" net would flag harmless schema backfills
 * (e.g. `UPDATE tasks SET tag = ...`) that carry no lifecycle meaning.
 *
 * Two assertions:
 *   1. NO `UPDATE tasks SET ... status` or `DELETE FROM tasks` outside the
 *      allowlist.
 *   2. Every allowlisted file actually calls `publish(` or
 *      `buildEventInsert(` — i.e., it emits, rather than silently writing.
 */

// Scan all of src/ (not just src/core) so workflow writers are covered.
const SRC_ROOT = resolve(__dirname, '..', '..', '..', 'src')
// A status write: `UPDATE tasks SET ... status = ...`. The SET clause and the
// `status =` assignment frequently sit on different physical lines, so the
// scan joins the whole file into one string before matching (see below).
const STATUS_WRITE_PATTERN =
  /UPDATE\s+tasks\s+SET[\s\S]*?\bstatus\s*=/
const DELETE_PATTERN = /DELETE\s+FROM\s+tasks\b/
// Also catch a `buildEventInsert`-free status write that happens to live on a
// single line (defence in depth for the per-line smoke scan).
const SINGLE_LINE_STATUS = /UPDATE\s+tasks\s+SET\b[^;]*\bstatus\s*=/

const ALLOWLIST = [
  'core/queue.ts',
  // core/arc.ts: the Arc aggregate owns the recovery-spawn write path
  // (Arc.spawnRecovery / Arc.attachToRecovery, ADR-0052). It flips the source
  // task to 'blocked' inside the same batch that emits the task.blocked event
  // via buildEventInsert(). The recovery-spawn logic moved here out of
  // queue-fix-tasks.ts, which is now a thin delegating wrapper with no status
  // write of its own.
  // core/arc.ts also owns the blocker-resolution status writes (ADR-0052):
  // unblockByCompletion / blockByTaskFailure / cascadeCancellation /
  // recoverAllBlocked (static) + recoverBlocked / propagateRecoveryDone
  // (instance) relocated out of core/blocker-resolution.ts, which is now a
  // helpers-only module with no `tasks.status` write of its own and has left
  // this allowlist.
  'core/arc.ts',
  'core/lib/main-dirty.ts',
  // main-dirty-action-queue.ts: releaseMainCommitterDependents flips blocked
  // tasks back to queued inside a transaction that also calls publish().
  'core/daemon/main-dirty-action-queue.ts',
  'workflows/slice-workflow.ts',
].map((p) => p.split('/').join(sep))

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
      // Test files legitimately embed SQL strings; the guard scans
      // production source only.
      out.push(full)
    }
  }
  return out
}

/**
 * Strip line and block comments so prose that quotes a SQL statement (e.g.
 * a doc comment "call before an `UPDATE tasks SET status = 'blocked'`
 * write") is not mistaken for an actual write.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** A file whose (comment-stripped) source matches a status-write or delete. */
const collectStatusWriters = (): { rel: string; text: string }[] => {
  const hits: { rel: string; text: string }[] = []
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file)
    const src = stripComments(readFileSync(file, 'utf8'))
    if (
      STATUS_WRITE_PATTERN.test(src) ||
      SINGLE_LINE_STATUS.test(src) ||
      DELETE_PATTERN.test(src)
    ) {
      hits.push({ rel, text: src })
    }
  }
  return hits
}

describe('architecture: tasks.status writes route through the single-writer emit', () => {
  it('the scanner regex actually matches a known raw status write', () => {
    // Meta-guard: a regex typo that matches nothing would make every other
    // assertion vacuously pass. Pin the pattern against representative SQL.
    expect(
      STATUS_WRITE_PATTERN.test(`UPDATE tasks\n  SET status = 'failed'`),
    ).toBe(true)
    expect(SINGLE_LINE_STATUS.test(`UPDATE tasks SET status = ? WHERE id = ?`)).toBe(
      true,
    )
    expect(DELETE_PATTERN.test(`DELETE FROM tasks WHERE id = ?`)).toBe(true)
    // Must NOT flag a non-status backfill write.
    expect(
      STATUS_WRITE_PATTERN.test(`UPDATE tasks SET tag = 'coder' WHERE tag IS NULL`),
    ).toBe(false)
  })

  it('no out-of-allowlist file writes tasks.status or deletes a tasks row', () => {
    const hits = collectStatusWriters()
    const offenders = hits
      .map((h) => h.rel)
      .filter((rel) => !ALLOWLIST.includes(rel))
    expect(
      offenders,
      `these files write tasks.status / delete tasks outside the allowlist — ` +
        `route them through a writer that emits its lifecycle event in-tx, ` +
        `or add them to the allowlist with a publish() emit:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('every allowlisted writer file emits (publish( or buildEventInsert()', () => {
    const byRel = new Map(collectStatusWriters().map((h) => [h.rel, h.text]))
    for (const allowed of ALLOWLIST) {
      const text = byRel.get(allowed)
      expect(text, `allowlisted writer ${allowed} not found on disk`).toBeDefined()
      const emits =
        /\bpublish\s*\(/.test(text!) || /\bbuildEventInsert\s*\(/.test(text!)
      expect(
        emits,
        `${allowed} writes tasks.status but never calls publish(/buildEventInsert( — ` +
          `it must emit its lifecycle event in the same transaction`,
      ).toBe(true)
    }
  })
})
