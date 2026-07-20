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
// tests need no daemon-provisioned embedded-postgres server. `??=` so a
// developer can still force `MARS_DB_BACKEND=embedded` against a live server.
process.env.MARS_DB_BACKEND ??= 'pglite'
