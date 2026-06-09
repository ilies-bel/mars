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
 * ── Three detection patterns for `tasks` (run over comment-stripped source,
 *    with the file joined into one string so a multi-line `SET …` clause
 *    matches) ──
 *
 *   1. INSERT — catches `INSERT INTO tasks`, `INSERT OR IGNORE INTO tasks`,
 *      `INSERT OR REPLACE INTO tasks`. The `(?!_)` negative-lookahead EXEMPTS
 *      `INSERT INTO tasks_new` (the migration-only table-rebuild in
 *      `migrateQueueSchema`, which is renamed to `tasks` afterwards).
 *   2. UPDATE — catches `UPDATE tasks SET …` for ANY column, not just
 *      `status =` (UPDATE_WRITE_PATTERN). This is the ADR-0052 sole-writer line:
 *      every task-row column write — status, priority, tag, origin_id, kind,
 *      tags_json, blocker_id, prompt, intent — must route through Arc, so a raw
 *      `UPDATE tasks SET priority`/`tag`/`origin_id` outside the allowlist now
 *      fails the build (the old guard saw only `status =` and was blind to the
 *      non-status column writes). The legitimate `migrateQueueSchema` backfills
 *      are the lone non-Arc UPDATEs and are exempted by the line-scoped
 *      `// arch-guard:migration-write` marker (see below); they are NOT
 *      lifecycle writes.
 *   3. DELETE — catches `DELETE FROM tasks` (lifecycle row deletes).
 *
 * ── Three detection patterns for `task_blockers` ──
 *   4. TB_INSERT — catches `INSERT [OR IGNORE|REPLACE] INTO task_blockers`.
 *      The `(?!_)` lookahead exempts `task_blockers_new` (migration rebuild).
 *   5. TB_UPDATE — catches `UPDATE task_blockers` (any column update).
 *   6. TB_DELETE — catches `DELETE FROM task_blockers` (edge row deletes).
 *
 * ── Migration exemption (the hard constraint) ──
 * `migrateQueueSchema` (queue.ts) legitimately runs several task-table and
 * task_blockers-table writes. Each is safe, and safe for a DISTINCT, explicit
 * reason (belt-and-braces):
 *   (a) `INSERT INTO tasks_new` / `UPDATE tasks_new …` — auto-exempt: the
 *       `(?!_)` lookahead skips `tasks_new`, and UPDATE requires `tasks` to be
 *       followed by whitespace+`SET`, not `_new`.
 *   (b) `INSERT INTO task_blockers_new` — auto-exempt via the same `(?!_)`
 *       lookahead in TB_INSERT.
 *   (c) `UPDATE tasks SET kind = …` / `tag = …` / `tags_json = …` /
 *       `origin_id = …` / `blocker_id = …` / `prompt = …` / `intent = …` — these
 *       legacy backfills ARE matched by UPDATE_WRITE_PATTERN (any-column), so
 *       each carries the line-scoped `// arch-guard:migration-write` marker that
 *       drops its physical line before matching. (The multi-line `kind`/`intent`
 *       backfills are single-lined so the `UPDATE tasks SET` token and the
 *       marker share one physical line.)
 *   (d) genuinely-flaggable migration writes are exempted by an HONORED comment
 *       marker carried on the SAME physical line as the SQL:
 *       - `// arch-guard:migration-delete` for DELETE statements.
 *       - `// arch-guard:migration-write` for INSERT/UPDATE statements.
 *       The guard, BEFORE comment-stripping, splits the source into lines and
 *       drops any line bearing either marker, then rejoins and strips comments.
 *       The markers are LINE-SCOPED and migration-only: they cannot blanket-
 *       disable patterns (the meta-guard below proves an UNMARKED write on the
 *       same synthetic file is still flagged), and a lifecycle write smuggled
 *       onto a marked line would be a visible review red flag.
 *
 * ── Assertions ──
 *   1. No out-of-allowlist file matches any task-table write (INSERT, ANY-column
 *      UPDATE, or DELETE) after marker + comment stripping, nor any task_blockers
 *      write. ALLOWLIST = ['core/arc.ts'] for both tables.
 *   2. `core/arc.ts` actually emits — it calls `publish(` or `buildEventInsert(`
 *      — proving the sole writer is event-emitting in-tx (ADR-0030), not a
 *      silent writer.
 */

// Scan all of src/ (not just src/core) so workflow / daemon writers are covered.
const SRC_ROOT = resolve(__dirname, '..', '..', '..', 'src')

// (1) INSERT INTO tasks — exempts `tasks_new` via the (?!_) lookahead.
const INSERT_PATTERN = /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+tasks\b(?!_)/i
// (2) ANY-column task UPDATE (ADR-0052: every task-row write routes through Arc,
//     not just `status =`). The `\b` after `tasks` (not `(?!_)`) plus the
//     required `SET` keyword exempts `UPDATE tasks_new SET …` (migration rebuild)
//     because `tasks_new` is not followed by whitespace+`SET`. Column-agnostic:
//     priority / tag / origin_id / kind / tags_json / blocker_id / prompt /
//     intent / status all match. The legitimate migrateQueueSchema backfills
//     carry the `// arch-guard:migration-write` marker (line-scoped strip).
const UPDATE_WRITE_PATTERN = /UPDATE\s+tasks\s+SET\b/i
// (3) lifecycle row delete.
const DELETE_PATTERN = /DELETE\s+FROM\s+tasks\b/i

// After path.sep normalization, the ONLY legitimate task-table and
// task_blockers-table writer.
const ALLOWLIST = ['core/arc.ts'].map((p) => p.split('/').join(sep))

// Honored migration-only markers. A physical line bearing either is dropped
// BEFORE comment-stripping (line-scoped; cannot blanket-disable patterns).
const MIGRATION_DELETE_MARKER = '// arch-guard:migration-delete'
const MIGRATION_WRITE_MARKER = '// arch-guard:migration-write'

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
 * Drop any physical line carrying an honored migration marker. Runs BEFORE
 * comment-stripping so the markers (JS `//` comments) are still present to
 * match. Line-scoped: only marked lines disappear. Covers both:
 *   - `// arch-guard:migration-delete` — exempts migration DELETE statements.
 *   - `// arch-guard:migration-write`  — exempts migration INSERT/UPDATE statements.
 */
const stripMigrationMarkedLines = (src: string): string =>
  src
    .split('\n')
    .filter(
      (line) =>
        !line.includes(MIGRATION_DELETE_MARKER) &&
        !line.includes(MIGRATION_WRITE_MARKER),
    )
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

/** True if the normalized source contains any of the 3 task-table writes. */
const matchesAnyWrite = (text: string): boolean =>
  // All three patterns are single-token (`INSERT … INTO tasks`, `UPDATE tasks
  // SET`, `DELETE FROM tasks`) — none carries a trailing `[\s\S]*`, so none can
  // bridge across statements. Matching on the whole comment-stripped text is
  // sound; no per-literal carving is needed now that UPDATE is column-agnostic.
  INSERT_PATTERN.test(text) ||
  UPDATE_WRITE_PATTERN.test(text) ||
  DELETE_PATTERN.test(text)

/** Files whose normalized source matches an INSERT / any-column UPDATE / DELETE. */
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

// ── task_blockers sole-writer patterns (ADR-0052 extended to the edge table) ──
//
// (4) TB_INSERT — catches INSERT [OR IGNORE|REPLACE] INTO task_blockers.
//     The (?!_) lookahead exempts `task_blockers_new` (migration rebuild only).
const TB_INSERT_PATTERN =
  /INSERT\s+(?:OR\s+(?:IGNORE|REPLACE)\s+)?INTO\s+task_blockers\b(?!_)/i
// (5) TB_UPDATE — any UPDATE task_blockers (column-agnostic; any update is a write).
const TB_UPDATE_PATTERN = /UPDATE\s+task_blockers\b/i
// (6) TB_DELETE — catches DELETE FROM task_blockers (edge row deletes).
const TB_DELETE_PATTERN = /DELETE\s+FROM\s+task_blockers\b/i

/** True if the normalized source contains any task_blockers write. */
const matchesAnyTBWrite = (text: string): boolean =>
  TB_INSERT_PATTERN.test(text) ||
  TB_UPDATE_PATTERN.test(text) ||
  TB_DELETE_PATTERN.test(text)

/**
 * Files whose normalized source matches a task_blockers INSERT / UPDATE /
 * DELETE (after migration-marker + comment stripping).
 */
const collectTBWriters = (): { rel: string; text: string }[] => {
  const hits: { rel: string; text: string }[] = []
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file)
    const text = normalizeForScan(readFileSync(file, 'utf8'))
    if (matchesAnyTBWrite(text)) {
      hits.push({ rel, text })
    }
  }
  return hits
}

describe('ADR-0052: the Arc aggregate is the sole task-table writer', () => {
  it('no out-of-allowlist file INSERTs / UPDATEs (any column) / DELETEs tasks', () => {
    const offenders = collectWriters()
      .map((h) => h.rel)
      .filter((rel) => rel !== ALLOWLIST[0])
    expect(
      offenders,
      'These files INSERT INTO tasks / UPDATE tasks SET <any column> / DELETE FROM tasks ' +
        'outside the Arc aggregate (ADR-0052 sole-writer). Every task-row write — status, ' +
        'priority, tag, origin_id, … — must route through an Arc method; relocate the write ' +
        'into core/arc.ts (the only legitimate task-table writer) or, for a migrateQueueSchema ' +
        `backfill, mark the line with // arch-guard:migration-write.\n${offenders.join('\n')}`,
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

  it('insertReflection calls maybeAssertArcInvariant after its INSERT (ADR-0052 write-path coverage)', () => {
    // Every Arc write path must call maybeAssertArcInvariant after its INSERT so
    // a future change cannot strand an entity without tripping the structural
    // assert. createOrigin and spawnRecovery both call it; this guards
    // insertReflection from regressing silently.
    const arcPath = resolve(SRC_ROOT, 'core', 'arc.ts')
    const raw = readFileSync(arcPath, 'utf8')
    const idx = raw.indexOf('async insertReflection(')
    expect(idx, 'insertReflection method not found in core/arc.ts').toBeGreaterThan(-1)
    // 600 chars covers any realistic method body (the method is ~15 lines).
    const methodWindow = raw.slice(idx, idx + 600)
    expect(
      methodWindow.includes('maybeAssertArcInvariant'),
      'insertReflection must call maybeAssertArcInvariant after its INSERT INTO tasks ' +
        '(ADR-0052: every Arc write path runs assertArcInvariant; createOrigin and ' +
        'spawnRecovery both do — insertReflection must too)',
    ).toBe(true)
  })
})

describe('ADR-0052: the Arc aggregate is the sole task_blockers writer', () => {
  it('no out-of-allowlist file INSERTs / UPDATEs / DELETEs task_blockers', () => {
    const offenders = collectTBWriters()
      .map((h) => h.rel)
      .filter((rel) => rel !== ALLOWLIST[0])
    expect(
      offenders,
      'These files INSERT / UPDATE / DELETE task_blockers outside the Arc aggregate ' +
        '(ADR-0052 sole-writer, extended to task_blockers). Relocate the write into ' +
        'core/arc.ts or route through an Arc method; the only legitimate ' +
        `task_blockers writer is Arc.\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})

describe('ADR-0052 sole-writer guard: meta-guard (regexes catch, do not over-flag)', () => {
  it('INSERT_PATTERN catches INSERT / INSERT OR IGNORE, exempts tasks_new', () => {
    expect(INSERT_PATTERN.test(`INSERT INTO tasks (id) VALUES (?)`)).toBe(true)
    expect(INSERT_PATTERN.test(`INSERT OR IGNORE INTO tasks (id) VALUES (?)`)).toBe(true)
    // migration table-rebuild NOT flagged
    expect(INSERT_PATTERN.test(`INSERT INTO tasks_new (id) SELECT id FROM tasks`)).toBe(false)
  })

  it('UPDATE_WRITE_PATTERN catches status AND non-status column UPDATEs', () => {
    // The ADR-0052 widening: not just `status =`. A priority / tag / origin_id
    // write — the kind of bypass setTaskPriority used to be — is now flagged.
    expect(UPDATE_WRITE_PATTERN.test(`UPDATE tasks SET status = ? WHERE id = ?`)).toBe(true)
    expect(
      UPDATE_WRITE_PATTERN.test(`UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?`),
    ).toBe(true)
    expect(UPDATE_WRITE_PATTERN.test(`UPDATE tasks SET tag = 'coder' WHERE tag IS NULL`)).toBe(
      true,
    )
    expect(
      UPDATE_WRITE_PATTERN.test(`UPDATE tasks SET origin_id = id WHERE origin_id IS NULL`),
    ).toBe(true)
  })

  it('UPDATE_WRITE_PATTERN exempts the migration table-rebuild (tasks_new)', () => {
    // `tasks_new` is not `tasks` followed by whitespace+SET, so the migration
    // rebuild UPDATE is not flagged (it is renamed to `tasks` afterwards).
    expect(
      UPDATE_WRITE_PATTERN.test(`UPDATE tasks_new SET origin_id = id WHERE origin_id IS NULL`),
    ).toBe(false)
  })

  it('DELETE_PATTERN catches a lifecycle row delete', () => {
    expect(DELETE_PATTERN.test(`DELETE FROM tasks WHERE id = ?`)).toBe(true)
  })

  it('planted INSERT / UPDATE (status AND priority) / DELETE WOULD be flagged by the collect predicate', () => {
    // Guards against a predicate-wiring typo that makes the assertions vacuous:
    // a synthetic file containing each task-table write must be flagged by the
    // SAME predicate the scan uses. The priority case is the regression this
    // refactor closes — the old status-only guard let it slip through.
    const insertFile = normalizeForScan(`await x.execute('INSERT INTO tasks (id) VALUES (?)')`)
    const statusFile = normalizeForScan(
      `await x.execute('UPDATE tasks SET status = ? WHERE id = ?')`,
    )
    const priorityFile = normalizeForScan(
      `await x.execute('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?')`,
    )
    const deleteFile = normalizeForScan(`await x.execute('DELETE FROM tasks WHERE id = ?')`)
    expect(matchesAnyWrite(insertFile)).toBe(true)
    expect(matchesAnyWrite(statusFile)).toBe(true)
    expect(matchesAnyWrite(priorityFile)).toBe(true)
    expect(matchesAnyWrite(deleteFile)).toBe(true)
  })

  it('migration-write marker is LINE-SCOPED: marked priority/tag UPDATE stripped, unmarked still flagged', () => {
    // A migrateQueueSchema backfill carrying the marker is dropped before
    // matching → not flagged. This is what keeps the legitimate non-status
    // backfills (tag/origin_id/kind/…) green under the widened pattern.
    const markedOnly = normalizeForScan(
      `await c.execute('UPDATE tasks SET tag = "coder" WHERE tag IS NULL') ${MIGRATION_WRITE_MARKER}`,
    )
    expect(matchesAnyWrite(markedOnly)).toBe(false)

    // The SAME synthetic file with an additional UNMARKED `UPDATE tasks SET`
    // line is still flagged — proving the marker does not blanket-disable the
    // UPDATE pattern, it only drops the one physical line that carries it.
    const markedPlusUnmarked = normalizeForScan(
      `await c.execute('UPDATE tasks SET tag = "coder" WHERE tag IS NULL') ${MIGRATION_WRITE_MARKER}\n` +
        `await c.execute('UPDATE tasks SET priority = ? WHERE id = ?')`,
    )
    expect(matchesAnyWrite(markedPlusUnmarked)).toBe(true)
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

  // ── task_blockers meta-guards ─────────────────────────────────────────────

  it('TB_INSERT_PATTERN catches task_blockers INSERTs, exempts task_blockers_new', () => {
    expect(
      TB_INSERT_PATTERN.test(`INSERT INTO task_blockers (task_id) VALUES (?)`),
    ).toBe(true)
    expect(
      TB_INSERT_PATTERN.test(
        `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)`,
      ),
    ).toBe(true)
    // migration table-rebuild NOT flagged
    expect(
      TB_INSERT_PATTERN.test(
        `INSERT INTO task_blockers_new (task_id, blocker_task_id, state, created_at) SELECT ...`,
      ),
    ).toBe(false)
  })

  it('TB_UPDATE_PATTERN catches task_blockers UPDATEs', () => {
    expect(
      TB_UPDATE_PATTERN.test(`UPDATE task_blockers SET state = 'confirmed' WHERE state IS NULL`),
    ).toBe(true)
  })

  it('TB_DELETE_PATTERN catches task_blockers DELETEs', () => {
    expect(
      TB_DELETE_PATTERN.test(`DELETE FROM task_blockers WHERE task_id = ?`),
    ).toBe(true)
  })

  it('planted task_blockers INSERT / UPDATE / DELETE WOULD be flagged', () => {
    const insertFile = normalizeForScan(
      `await x.execute('INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)')`,
    )
    const updateFile = normalizeForScan(
      `await x.execute("UPDATE task_blockers SET state = 'confirmed' WHERE state IS NULL")`,
    )
    const deleteFile = normalizeForScan(
      `await x.execute('DELETE FROM task_blockers WHERE task_id = ?')`,
    )
    expect(matchesAnyTBWrite(insertFile)).toBe(true)
    expect(matchesAnyTBWrite(updateFile)).toBe(true)
    expect(matchesAnyTBWrite(deleteFile)).toBe(true)
  })

  it('task_blockers migration markers are LINE-SCOPED: marked lines stripped, unmarked still flagged', () => {
    // arch-guard:migration-delete strips a DELETE line.
    const markedDelete = normalizeForScan(
      `await c.execute('DELETE FROM task_blockers WHERE task_id = ?') ${MIGRATION_DELETE_MARKER}`,
    )
    expect(matchesAnyTBWrite(markedDelete)).toBe(false)

    // arch-guard:migration-write strips an INSERT/UPDATE line.
    const markedInsert = normalizeForScan(
      `await c.execute({ sql: 'INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)' }) ${MIGRATION_WRITE_MARKER}`,
    )
    expect(matchesAnyTBWrite(markedInsert)).toBe(false)

    // An UNMARKED task_blockers write on the same synthetic file is still flagged.
    const markedPlusUnmarked = normalizeForScan(
      `await c.execute('DELETE FROM task_blockers WHERE task_id = ?') ${MIGRATION_DELETE_MARKER}\n` +
        `await c.execute('INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at) VALUES (?, ?, ?)')`,
    )
    expect(matchesAnyTBWrite(markedPlusUnmarked)).toBe(true)
  })
})
