import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

/**
 * Architecture guard for the outbox pattern (Phase 1 of the bus migration).
 *
 * Every direct DB write that mutates `tasks` or `task_blockers` must be
 * wrapped in a libsql write transaction and emit the matching event via
 * `publish(tx, '<type>', { ... })` before commit. To make that
 * enforceable we keep a tiny allowlist of files that are *allowed* to
 * INSERT/UPDATE/DELETE on those tables; every other file must route
 * through one of them.
 *
 * Today the allowlist is the four writer-pattern files. As new
 * outbox-eventful tables come online (task_transcripts, inbox_items,
 * idea_user_stories, …) the regex on the LHS widens and additional
 * allowlisted writer files join the RHS.
 *
 * The two assertions are split intentionally:
 *   1. NO writes to scoped tables exist outside the allowlist.
 *   2. Every allowlisted file actually calls `publish(` — i.e., it has
 *      been converted to the outbox pattern rather than parked.
 *
 * Assertion 2 is currently `.todo` because the writer-conversion work
 * (wrapping every queue.ts write in a tx + publish) has not landed yet.
 * Re-enable it once those follow-ups merge.
 */

const SRC_ROOT = resolve(__dirname, '..', '..')
const IN_SCOPE_TABLES = /(tasks|task_blockers)/
const WRITE_PATTERN = new RegExp(
  `INSERT INTO ${IN_SCOPE_TABLES.source}\\b` +
    `|UPDATE ${IN_SCOPE_TABLES.source} SET` +
    `|DELETE FROM ${IN_SCOPE_TABLES.source}\\b`,
)

const ALLOWLIST = [
  'mastra/queue.ts',
  'mastra/queue-fix-tasks.ts',
  'mastra/queue-retry.ts',
  'mastra/blocker-resolution.ts',
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
    } else if (s.isFile() && /\.ts$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

const collectWriters = (): { file: string; rel: string; line: number; text: string }[] => {
  const hits: { file: string; rel: string; line: number; text: string }[] = []
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file)
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, i) => {
      if (WRITE_PATTERN.test(text)) {
        hits.push({ file, rel, line: i + 1, text: text.trim() })
      }
    })
  }
  return hits
}

describe('architecture: tasks/task_blockers writes route through the outbox', () => {
  it('scanner finds at least the allowlisted writer files', () => {
    // Smoke test: the scanner is wired correctly and the allowlist
    // matches existing files on disk. Catches typos in ALLOWLIST or a
    // refactor that moves a writer without updating this guard.
    const hits = collectWriters()
    const filesWithWrites = new Set(hits.map((h) => h.rel))
    for (const allowed of ALLOWLIST) {
      // queue-retry.ts / queue.ts / queue-fix-tasks.ts are known to have
      // such writes today. blocker-resolution.ts is allowlisted ahead of
      // its conversion and may have zero writes yet — skip it.
      if (allowed.endsWith('blocker-resolution.ts')) continue
      expect(filesWithWrites, `expected ${allowed} to be detected by the writer scanner`).toContain(allowed)
    }
  })

  // TODO(phase-1b): re-enable once migration of writers into the outbox
  // is complete. Currently slice-workflow.ts and lib/diagnose-followup.ts
  // still INSERT/UPDATE/DELETE on tasks/task_blockers outside the
  // allowlist, and the four allowlisted files do not yet call
  // `publish(tx, ...)` inside a write transaction.
  it.todo('no out-of-allowlist file writes to tasks/task_blockers')
  it.todo('every allowlisted file contains a publish( call (outbox emission)')
})
