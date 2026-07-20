# Migration 0002 — SQLite (@libsql/client) → embedded PostgreSQL

Status: in progress (branch `migrate/embedded-postgres`).
Motivation: every process (daemon, each CLI invocation, UI server, agents'
raw `sqlite3` reads) opened `.mars/mars.db` directly; WAL pragmas were
applied fire-and-forget and concurrent writers hit `SQLITE_BUSY` under
load (2026-07-20 incident: `mars restart` failed 6+ times in a row while
the daemon dispatched; task mars-cd826623 terminally failed with
`SQLITE_BUSY` as its failure reason). Postgres MVCC removes the file-lock
contention class entirely while keeping zero-setup via an embedded,
daemon-provisioned server (the model used by paperclipai/paperclip).

## Decisions

1. **Runtime engine**: `embedded-postgres` (npm). The daemon provisions
   and owns one PostgreSQL instance per repo:
   - data dir `.mars/pg/data`, bound to `127.0.0.1` on an OS-assigned
     port, `trust` auth on loopback, user `mars`, database `mars`.
   - After the server is ready the daemon publishes `.mars/pg.port`
     (port number) and `.mars/pg.dsn` (full connection string,
     `postgres://mars@127.0.0.1:<port>/mars`) — exact same pattern as
     `.mars/http.port`. Consumers read the file, never guess.
   - Provisioning is idempotent/reusing: if `postmaster.pid` in the data
     dir names a live postmaster, connect to it instead of starting a
     second one (covers daemon-restart overlap and crashed daemons that
     orphaned the server). Daemon shutdown stops the server after the
     trace store closes; `pg.port`/`pg.dsn` join the unlink list.
   - The PG child runs in the daemon's process group on purpose: the
     `mars daemon kill` SIGKILL-the-group path takes the postmaster down
     with it, and PG's own WAL recovery handles the unclean stop on next
     boot.

2. **Test engine**: `@electric-sql/pglite` (in-process WASM Postgres,
   same SQL dialect). Selected via `MARS_DB_BACKEND=pglite`, which
   `orchestrator/test/setup-env.ts` sets globally for vitest. PGlite runs
   `memory://` per process — the existing per-file fixture pattern
   (mkdtemp repo + `MARS_REPO` + `vi.resetModules()` + ensureSchema)
   keeps working because DB identity stays derived from the resolved
   context and module-level singletons.

3. **Client seam**: `orchestrator/src/core/lib/db.ts` replaces
   `core/lib/libsql.ts` (hard cut — libsql.ts is deleted, all imports
   move). The seam preserves the libsql call-site shape:
   - `openDb(dsnOrHandle): DbClient` where
     `DbClient.execute(sql, args?) → Promise<{rows: Row[], rowsAffected: number}>`
     with `?` positional placeholders **translated to `$n` inside the
     wrapper** (quote-aware scan), so call sites keep `?`.
   - `withTransaction(client, fn)` — BEGIN/COMMIT/ROLLBACK on a
     dedicated connection (pg Pool checkout); on PGlite, transactions
     serialize behind an internal mutex (single session).
   - `DbClient.batch(stmts)` executes statements in one implicit
     transaction (libsql batch semantics).
   - One **shared client registry keyed by DSN/data-dir** per process:
     `resolveQueueClient()`, `resolveStateClient()` and the trace store
     all return handles onto the same pool (wire) or the same PGlite
     instance (tests). Three separate connections to one file was a
     SQLite artifact.
   - No `lastInsertRowid`: the few sites that need generated ids use
     `INSERT ... RETURNING id`.

4. **Schema**: a single canonical DDL module
   `orchestrator/src/core/lib/pg-schema.ts` (`ensureSchema(client)`)
   containing the complete ~40-table schema, all indexes (incl. partial
   and DESC), CHECK constraints and FKs. It replaces the ~1,300-line
   imperative `migrateQueueSchema` PRAGMA-introspection engine wholesale
   (Mars is pre-1.0; the SQLite-era in-place migration history is
   captured once by the importer instead). A `schema_migrations` table
   records the schema version for future evolution.
   Type translation is minimal-churn:
   - `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint GENERATED ALWAYS AS
     IDENTITY` (outbox cursor monotonicity preserved by the sequence).
   - `BLOB` → `bytea` (gzip transcripts round-trip as `Uint8Array`).
   - `DEFAULT (unixepoch())` → `DEFAULT floor(extract(epoch from now()))::bigint`.
   - TEXT ISO-8601 timestamps and 0/1 integer booleans **stay as-is**
     (lexical comparison and integer flags behave identically; retyping
     is out of scope).
   - JSON-in-TEXT columns stay TEXT; queries cast `col::jsonb` where
     they used `json_extract`.
   - The `tool_promotion_attempts` DDL conflict (queue.ts vs
     tool-promotion-store.ts) is resolved in favor of the store version
     (`proposed/benchmarked/promoted/retired`, `benchmark_before/after`,
     `decided_at`, INTEGER `created_at`) — the store module is the only
     runtime reader/writer; the queue.ts stub is deleted.
   - Duplicated DDL (trace_events ×4, task_durable_transcripts ×3,
     task_transcripts ×2, proposals stub in queue.ts) is centralized in
     pg-schema.ts; all other CREATE sites are deleted.

5. **One-time importer**: `orchestrator/src/init/import-sqlite.ts`
   replaces `merge-databases.ts`. On daemon/init start, if
   `.mars/mars.db` exists and PG's `schema_migrations` is empty:
   read the SQLite file via **`node:sqlite`** (`DatabaseSync` — read
   path only; `@libsql/client` is dropped from package.json), copy
   table-by-table in dependency order (app-enforced, FKs deferred via
   `SET session_replication_role = replica` during import), fix identity
   sequences (`setval`), then rename the file to
   `mars.db.bak-<unix-ts>` (WAL/SHM siblings too). Legacy
   `queue.db`/`state.db` pre-merge artifacts are ignored (dead since
   ADR-0034).

6. **Dialect rules applied across call sites** (the cheat sheet):
   - `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
   - `INSERT OR REPLACE` → `INSERT ... ON CONFLICT (<pk>) DO UPDATE SET ...`
   - `PRAGMA table_info/foreign_key_list/sqlite_master` probes →
     `information_schema` / `to_regclass()` (most die with the migration
     engine anyway)
   - `json_extract(col,'$.a.b')` → `col::jsonb #>> '{a,b}'` (or `->>`)
   - `json_group_array(x ORDER BY y)` → `json_agg(x ORDER BY y)`;
     `GROUP_CONCAT` → `string_agg`
   - `rowid` → primary key (retention-prune batched deletes, chat-store
     ordering use PK/created_at)
   - `unixepoch()` → `floor(extract(epoch from now()))::bigint`;
     `datetime('now','-1 day')` → `now() - interval '1 day'` (compare
     against TEXT columns via `to_char(now() at time zone 'utc', ...)`
     or keep app-side timestamp strings — prefer app-side generation,
     which most sites already do)
   - `LIKE` on user text → `ILIKE` where SQLite's case-insensitive LIKE
     was relied on (trace-event payload filter, action-queue scans);
     id-prefix `id LIKE ? || '%'` stays LIKE
   - alias-in-HAVING (`HAVING cnt >= ?`) → repeat the aggregate
     expression
   - `INSTR`→`strpos`, `CHAR(10)`→`chr(10)`
   - `typeof(x)='blob'` heals and other type-affinity repair → deleted
   - `PRAGMA wal_checkpoint(TRUNCATE)`, `VACUUM` sweeps, dbstat size
     watchdog → `pg_total_relation_size` for size; checkpoint/vacuum
     sweeps deleted (autovacuum) or become `VACUUM (ANALYZE)` where a
     deliberate compaction verb exists (`mars db compact`)
   - SQLITE_BUSY retry/reconnect machinery (bus/publisher withWriteTx
     retry, stale-detection STALE_TABLE_RE, failure-signature error
     classes, fix-recipes `:memory:`→`file:` recipe) → simplified or
     retargeted to PG error codes (`42P01` undefined_table, `57P03`
     cannot_connect_now, connection-refused)
   - bigint: `pg` returns int8 as string by default — the wrapper
     installs global type parsers so `int8`/`numeric` come back as JS
     numbers, preserving libsql's `Number` behavior (values stay far
     below 2^53 here).

7. **UI server**: finish the already-95%-done daemon-HTTP cut instead of
   porting `ui/server/db.ts`: the remaining direct reads
   (`/api/tasks/:id` on TaskDb, StateDb reads + the one write
   `dismissDraftFeature`) move to daemon HTTP routes; `watch.ts`
   fs.watch on mars.db/-wal/-shm is replaced by subscribing to the
   daemon's existing SSE/event stream. `ui/server/db.ts` is deleted.

8. **statusline**: the `sqlite3` shell-out becomes a daemon-HTTP read
   with a tight timeout; if the daemon is down it prints the minimal
   placeholder instead of spawning anything.

9. **CLI**: unchanged UX. `resolveContext` gains DSN resolution (read
   `.mars/pg.dsn`); if absent/unreachable the existing daemon auto-spawn
   path runs first (daemon provisions PG), then the CLI connects.
   `mars db compact` maps to `VACUUM (ANALYZE)`.

10. **Distribution (deferred, documented)**: dev installs (tsx from
    source, node_modules present) get PG binaries via the
    `embedded-postgres` platform packages (add to
    `pnpm.onlyBuiltDependencies`). The Bun-compiled prod binaries can't
    run npm platform-package downloads — prod packaging (release.yml
    assets or first-run download) is an explicit follow-up, NOT part of
    this branch. `packages/workflow`'s node:sqlite `SqliteStore` stays
    (engine-local reference store; the orchestrator's
    `queue-workflow-store.ts` adapter is what migrates). The DuckDB
    observability file is untouched.

## Env / file contract

| Artifact | Meaning |
| --- | --- |
| `.mars/pg/data/` | Postgres data dir (gitignored with the rest of `.mars`) |
| `.mars/pg.port` | assigned port, one line |
| `.mars/pg.dsn` | full DSN, one line — the single source of truth for every consumer |
| `MARS_DB_BACKEND` | `embedded` (default) / `pglite` (tests) |
| `.mars/mars.db.bak-<ts>` | pre-import SQLite file, preserved |

## Verification

- `(cd orchestrator && npm run typecheck && npm test)` — full suite on
  PGlite backend.
- E2E smoke: scratch repo → `mars init` → daemon start → PG files
  published → `task add` → row visible via `psql "$(cat .mars/pg.dsn)"`
  → daemon stop → PG stopped, restart reuses data dir.
- Import smoke: copy of a real mars.db imported; row counts match per
  table; sequences advanced past max(id).
