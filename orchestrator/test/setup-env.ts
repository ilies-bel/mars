/**
 * Vitest global setup (ADR-0052).
 *
 * Turns ON the Arc-invariant debug-assert seam for the whole suite so every
 * arc-mutating test exercises {@link Arc.assertArcInvariant} after the commit.
 * In production the flag is unset (default off) so the invariant pays no
 * SELECT round-trip on the hot write path; CI/tests set it here so a write
 * method that strands an entity fails loudly.
 */
process.env.MARS_ARC_INVARIANT_CHECK = '1'

// Migration 0002: the whole suite runs on the in-process PGlite backend so
// tests need no daemon-provisioned embedded-postgres server.
//
// IMPORTANT: this is an unconditional assignment (`=`, not `??=`).
//
// When a live daemon is running against the same repo it publishes a
// `.mars/pg.dsn` and typically exports `MARS_DB_BACKEND=embedded` into its
// environment.  Any shell that launched the daemon inherits that export, so a
// bare `npm test` in that shell would connect the test suite to the daemon's
// live PostgreSQL.  Rows the daemon writes asynchronously then move under
// in-flight assertions, producing the non-deterministic failures documented in
// ADR-0069.
//
// Forcing `pglite` here — regardless of what the caller's shell says — ensures
// every worker fork gets an in-process, in-memory database that is isolated
// from the live server.  Developers who need to exercise the embedded backend
// explicitly must do so within the test (see `src/core/lib/db.test.ts` for the
// pattern: wrap the embedded-mode section in try/finally and restore `pglite`).
process.env.MARS_DB_BACKEND = 'pglite'

// Temporary compatibility for test fixtures that still spell their setup DDL
// in SQLite syntax. Production code never sets this flag.
process.env.MARS_DB_SQLITE_FIXTURE_COMPAT = '1'
