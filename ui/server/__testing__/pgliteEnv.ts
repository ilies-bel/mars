/**
 * Selects the in-memory PGlite database backend for UI server tests.
 *
 * Import this for side effect — BEFORE any module that opens a database —
 * from every ui/server test that goes through `openTraceEventStore` or any
 * other `openDb` caller:
 *
 *     import './__testing__/pgliteEnv.ts'
 *
 * Why it is needed: `openDb` defaults to `MARS_DB_BACKEND=embedded`, which
 * demands a real `postgres://` DSN read from `.mars/pg.dsn`. UI server tests
 * build a throwaway repo in tmpdir and have no daemon to provision embedded
 * PostgreSQL, so they hand `openDb` a plain path. Under `embedded` that path
 * is rejected outright:
 *
 *     db: embedded backend expects a postgres:// DSN, got '…/.mars/mars.db'
 *
 * Under `pglite` the same string is an opaque identity key for an in-memory
 * database, which is exactly what a hermetic test wants.
 *
 * The orchestrator suite gets this from `orchestrator/test/setup-env.ts`; the
 * UI suite has no equivalent global hook shared by both its runners (vitest
 * and Bun), so the dependency is stated per-file instead of hidden in a
 * runner config that only one of the two would honour.
 */

process.env.MARS_DB_BACKEND ??= 'pglite'
