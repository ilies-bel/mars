import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

/**
 * ADR-0052 sole-writer arch-guard (STRICT). The Arc aggregate root
 * (`core/arc.ts`) is the ONLY production source file permitted to
 * `INSERT INTO tasks`, `UPDATE tasks SET ... status`, or `DELETE FROM tasks`.
 * Every lifecycle task-table mutation must route through an Arc method so the
 * matching outbox lifecycle event is emitted in the SAME transaction (ADR-0030)
 * and no entity is stranded by construction (ADR-0052). A raw lifecycle write
 * anywhere else fails this test.
 *
 * This is the strict successor to the old `db-writes-eventful.test.ts`
 * (HARD CUT — that 6-file-allowlist guard is deleted; this single guard with
 * `ALLOWLIST = ['core/arc.ts']` replaces it). The companion
 * `status-writer-singleton.test.ts` (status-as-first-column confined to
 * `Arc.setTaskStatus`) is a finer, complementary check and coexists.
 *
 * ── Three detection patterns (run over comment-stripped source, with the file
 *    joined into one string so a multi-line `SET … status =` clause matches) ──
 *
 *   1. INSERT — catches `INSERT INTO tasks`, `INSERT OR IGNORE INTO tasks`,
 *      `INSERT OR REPLACE INTO tasks`. The `(?!_)` negative-lookahead EXEMPTS
 *      `INSERT INTO tasks_new` (the migration-only table-rebuild in
 *      `migrateQueueSchema`, which is renamed to `tasks` afterwards).
 *   2. STATUS — catches `UPDATE tasks SET … status = …` (multi-line via
 *      STATUS_WRITE_PATTERN, one-line via SINGLE_LINE_STATUS). Deliberately NOT
 *      "any UPDATE tasks": tag / origin_id / priority / kind / tags_json /
 *      blocker_id / prompt backfills carry no lifecycle meaning and must not be
 *      flagged.
 *   3. DELETE — catches `DELETE FROM tasks` (lifecycle row deletes).
 *
 * ── Migration exemption (the hard constraint) ──
 * `migrateQueueSchema` (queue.ts) legitimately runs several task-table writes.
 * Each is safe, and safe for a DISTINCT, explicit reason (belt-and-braces):
 *   (a) `INSERT INTO tasks_new` / `UPDATE tasks_new …` — auto-exempt: the
 *       `(?!_)` lookahead skips `tasks_new`, and STATUS requires `tasks` to be
 *       followed by whitespace+`SET`, not `_new`.
 *   (b) `UPDATE tasks SET kind = …` / `tag = …` / `tags_json = …` /
 *       `origin_id = …` / `blocker_id = …` / `prompt = …` — NOT status writes,
 *       so STATUS never matches them (column-name gated, not table gated).
 *   (c) the ONE genuinely-flaggable line — the orphan-cleanup
 *       `DELETE FROM tasks WHERE kind='fix' AND fix_for_task_id IS NULL`
 *       (ADR-0049 legacy purge) — is exempted by an HONORED comment marker
 *       `// arch-guard:migration-delete` carried on the SAME physical line as
 *       the DELETE. The guard, BEFORE comment-stripping, splits the source into
 *       lines and drops any line bearing the marker, then rejoins and strips
 *       comments. The marker is therefore LINE-SCOPED and migration-only: it
 *       cannot blanket-disable the DELETE pattern (the meta-guard below proves
 *       an UNMARKED `DELETE FROM tasks` on the same synthetic file is still
 *       flagged), and a lifecycle delete smuggled onto a marked line would be a
 *       visible review red flag.
 *
 * ── Two assertions ──
 *   1. No out-of-allowlist file matches any of the 3 patterns (after marker +
 *      comment stripping).
 *   2. `core/arc.ts` actually emits — it calls `publish(` or `buildEventInsert(`
 *      — proving the sole writer is event-emitting in-tx (ADR-0030), not a
 *      silent writer.
 */

// Scan all of src/ (not just src/core) so workflow / daemon writers are covered.
const SRC_ROOT = resolve(__dirname, '..', '..', '..', 'src')

// (1) INSERT INTO tasks — exempts `tasks_new` via the (?!_) lookahead.
const INSERT_PATTERN = /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+tasks\b(?!_)/i
// (2) status write — multi-line (SET clause and `status =` on different lines)
//     and single-line forms.
const STATUS_WRITE_PATTERN = /UPDATE\s+tasks\s+SET[\s\S]*?\bstatus\s*=/i
const SINGLE_LINE_STATUS = /UPDATE\s+tasks\s+SET\b[^;]*\bstatus\s*=/i
// (3) lifecycle row delete.
const DELETE_PATTERN = /DELETE\s+FROM\s+tasks\b/i

// After path.sep normalization, the ONLY legitimate task-table writer.
const ALLOWLIST = ['core/arc.ts'].map((p) => p.split('/').join(sep))

// Honored migration-only marker. A physical line bearing it is dropped BEFORE
// comment-stripping (line-scoped; cannot blanket-disable the DELETE pattern).
const MIGRATION_DELETE_MARKER = '// arch-guard:migration-delete'

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
      // *.test.ts files legitimately embed SQL strings; scan production only.
      out.push(full)
    }
  }
  return out
}

/**
 * Drop any physical line carrying the honored migration-delete marker. Runs
 * BEFORE comment-stripping so the marker (a `//` comment) is still present to
 * match. Line-scoped: only the marked line disappears.
 */
const stripMigrationMarkedLines = (src: string): string =>
  src
    .split('\n')
    .filter((line) => !line.includes(MIGRATION_DELETE_MARKER))
    .join('\n')

/**
 * Strip line and block comments so prose that quotes a SQL statement (e.g. a
 * doc comment naming `DELETE FROM tasks`) is not mistaken for an actual write.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/**
 * Normalize a file's source for matching: drop migration-marked lines, then
 * strip comments. The file stays one string so a multi-line SET clause inside a
 * SINGLE SQL literal still matches the multi-line STATUS pattern.
 */
const normalizeForScan = (raw: string): string =>
  stripComments(stripMigrationMarkedLines(raw))

/**
 * Carve the (comment-stripped) source into the SQL-string literals it contains:
 * backtick template literals plus single/double-quoted strings. Every real SQL
 * statement in this codebase lives inside ONE such literal, so the multi-line
 * STATUS pattern is applied per-literal — this is what makes the ADR-0052
 * stated invariant true ("the kind/tag/origin_id/… backfills are NOT status
 * writes so STATUS_WRITE never matches them"): a non-status `UPDATE tasks SET
 * kind = …` literal cannot bridge across the whole file to a faraway `status =`
 * token (e.g. a column-patch builder fragment) in an unrelated statement. It is
 * strictly MORE precise, never weaker: any genuine multi-line `UPDATE tasks SET
 * … status =` write is wholly contained in one literal and still matches.
 */
const sqlLiterals = (text: string): string[] =>
  text.match(/`(?:\\[\s\S]|[^\\`])*`|'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*"/g) ?? []

/** True if the normalized source contains any of the 3 lifecycle writes. */
const matchesAnyWrite = (text: string): boolean => {
  // INSERT / DELETE are single-token and SINGLE_LINE_STATUS is `;`/line-bounded,
  // so they cannot bridge across statements — match them on the whole text.
  if (INSERT_PATTERN.test(text)) return true
  if (DELETE_PATTERN.test(text)) return true
  if (SINGLE_LINE_STATUS.test(text)) return true
  // The multi-line STATUS pattern is the only bridging-prone one — confine it
  // to each individual SQL literal.
  return sqlLiterals(text).some((lit) => STATUS_WRITE_PATTERN.test(lit))
}

/** Files whose normalized source matches an INSERT / status UPDATE / DELETE. */
const collectWriters = (): { rel: string; text: string }[] => {
  const hits: { rel: string; text: string }[] = []
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file)
    const text = normalizeForScan(readFileSync(file, 'utf8'))
    if (matchesAnyWrite(text)) {
      hits.push({ rel, text })
    }
  }
  return hits
}

describe('ADR-0052: the Arc aggregate is the sole task-table writer', () => {
  it('no out-of-allowlist file INSERTs / status-UPDATEs / DELETEs tasks', () => {
    const offenders = collectWriters()
      .map((h) => h.rel)
      .filter((rel) => rel !== ALLOWLIST[0])
    expect(
      offenders,
      'These files INSERT INTO tasks / UPDATE tasks SET status / DELETE FROM tasks ' +
        'outside the Arc aggregate (ADR-0052 sole-writer). Relocate the write into ' +
        'core/arc.ts or route through an Arc method; the only legitimate task-table ' +
        `writer is Arc.\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('core/arc.ts emits lifecycle events in-tx (publish( / buildEventInsert()', () => {
    const byRel = new Map(collectWriters().map((h) => [h.rel, h.text]))
    const text = byRel.get(ALLOWLIST[0])
    expect(text, `the Arc aggregate ${ALLOWLIST[0]} was not found among writers`).toBeDefined()
    const emits =
      /\bpublish\s*\(/.test(text!) || /\bbuildEventInsert\s*\(/.test(text!)
    expect(
      emits,
      `${ALLOWLIST[0]} writes the task table but never calls publish(/buildEventInsert( — ` +
        'the sole writer must emit its lifecycle event in the same transaction (ADR-0030)',
    ).toBe(true)
  })
})

describe('ADR-0052 sole-writer guard: meta-guard (regexes catch, do not over-flag)', () => {
  it('INSERT_PATTERN catches INSERT / INSERT OR IGNORE, exempts tasks_new', () => {
    expect(INSERT_PATTERN.test(`INSERT INTO tasks (id) VALUES (?)`)).toBe(true)
    expect(INSERT_PATTERN.test(`INSERT OR IGNORE INTO tasks (id) VALUES (?)`)).toBe(true)
    // migration table-rebuild NOT flagged
    expect(INSERT_PATTERN.test(`INSERT INTO tasks_new (id) SELECT id FROM tasks`)).toBe(false)
  })

  it('STATUS patterns catch multi-line and one-line status UPDATEs', () => {
    expect(STATUS_WRITE_PATTERN.test(`UPDATE tasks\n  SET status = 'failed'`)).toBe(true)
    expect(SINGLE_LINE_STATUS.test(`UPDATE tasks SET status = ? WHERE id = ?`)).toBe(true)
  })

  it('DELETE_PATTERN catches a lifecycle row delete', () => {
    expect(DELETE_PATTERN.test(`DELETE FROM tasks WHERE id = ?`)).toBe(true)
  })

  it('STATUS patterns do NOT flag non-status backfills (tag/tags_json/origin_id)', () => {
    expect(
      STATUS_WRITE_PATTERN.test(`UPDATE tasks SET tag = 'coder' WHERE tag IS NULL`),
    ).toBe(false)
    expect(
      STATUS_WRITE_PATTERN.test(
        `UPDATE tasks SET tags_json = json_array(...) WHERE tags_json IS NULL`,
      ),
    ).toBe(false)
    expect(
      STATUS_WRITE_PATTERN.test(`UPDATE tasks SET origin_id = id WHERE origin_id IS NULL`),
    ).toBe(false)
  })

  it('planted INSERT / status-UPDATE / DELETE WOULD be flagged by the collect predicate', () => {
    // Guards against a predicate-wiring typo that makes the assertions vacuous:
    // a synthetic file containing each lifecycle write must be flagged by the
    // SAME predicate the scan uses.
    const insertFile = normalizeForScan(`await x.execute('INSERT INTO tasks (id) VALUES (?)')`)
    const statusFile = normalizeForScan(
      `await x.execute('UPDATE tasks\n  SET status = ? WHERE id = ?')`,
    )
    const deleteFile = normalizeForScan(`await x.execute('DELETE FROM tasks WHERE id = ?')`)
    expect(matchesAnyWrite(insertFile)).toBe(true)
    expect(matchesAnyWrite(statusFile)).toBe(true)
    expect(matchesAnyWrite(deleteFile)).toBe(true)
  })

  it('migration marker is LINE-SCOPED: marked DELETE stripped, unmarked DELETE still flagged', () => {
    // A marked DELETE line is dropped before matching → not flagged.
    const markedOnly = normalizeForScan(
      `await c.execute('DELETE FROM tasks WHERE kind = "fix"') ${MIGRATION_DELETE_MARKER}`,
    )
    expect(matchesAnyWrite(markedOnly)).toBe(false)

    // The SAME synthetic file with an additional UNMARKED `DELETE FROM tasks`
    // line is still flagged — proving the marker does not blanket-disable the
    // DELETE pattern, it only drops the one physical line that carries it.
    const markedPlusUnmarked = normalizeForScan(
      `await c.execute('DELETE FROM tasks WHERE kind = "fix"') ${MIGRATION_DELETE_MARKER}\n` +
        `await c.execute('DELETE FROM tasks WHERE id = ?')`,
    )
    expect(matchesAnyWrite(markedPlusUnmarked)).toBe(true)
  })
})
