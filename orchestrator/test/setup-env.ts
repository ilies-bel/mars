/**
 * Vitest global setup (ADR-0052).
 *
 * Turns ON the Arc-invariant debug-assert seam for the whole suite so every
 * arc-mutating test exercises {@link Arc.assertArcInvariant} after the commit.
 * In production the flag is unset (default off) so the invariant pays no
 * SELECT round-trip on the hot write path; CI/tests set it here so a write
 * method that strands an entity fails loudly.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { beforeEach } from 'vitest'

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
// in-flight assertions, producing non-deterministic test failures (observed:
// `getTestDb > gives a later test setup an empty database` and 2404 failures
// while the daemon was active, vs the same suite passing when host state was
// quiet — ADR-0095 documents the isolation strategy).
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

// MARS_PROJECTS_FILE — redirect the project registry away from the developer's
// real ~/.mars/projects.json. Without this, every daemon or UI server boot
// inside a mkdtempSync temp repo writes a permanent row into the registry,
// naming a directory that is deleted seconds later (observed: 30 → 421 entries
// across a handful of suite runs).
//
// IMPORTANT: unconditional assignment (`=`, not `??=`) — same reason as
// MARS_DB_BACKEND above. A developer's shell may export MARS_PROJECTS_FILE;
// we must override it here so tests always write to a throwaway path.
//
// Use process.pid so parallel worker forks (Vitest's forks pool) each get an
// independent file and never collide. The file lands inside the per-run temp
// root that global-teardown.ts mints (via TMPDIR), so it is deleted with the
// rest of this run's fixtures once every worker exits.
process.env.MARS_PROJECTS_FILE = join(tmpdir(), `mars-test-projects-${process.pid}.json`)

// ── Hermetic repo isolation ────────────────────────────────────────────────
//
// MARS_REPO — redirect context resolution to an isolated per-fork temp dir.
//
// resolveContext() walks CWD upward (via `git rev-parse --git-common-dir`) to
// find the repo root, then sets stateDir = <repoRoot>/.mars.  When a test
// worker fork runs inside a task worktree (.mars/worktrees/<id>/), the walker
// correctly escapes back to the *real* repo root — meaning stateDir points at
// the LIVE .mars/.  If the daemon has written an autotune cap to
// .mars/daemon.json (e.g. caps.verify: 2), loadDaemonConfig() reads that cap
// and overwrites any MARS_MAX_* env value the test sets (observed: test sets
// MARS_MAX_VERIFY=1, gets back 2).  The full suite run is also non-deterministic
// when the daemon inserts or mutates rows under in-flight assertions.
//
// The fix: set MARS_REPO to a hermetic per-fork temp dir so resolveContext()
// never reaches the live .mars.  No daemon.json → only env caps apply.  No
// pg.dsn → MARS_DB_BACKEND=pglite (already set above) redirects DB access to
// the in-process PGlite backend instead.
//
// Use process.pid for uniqueness across parallel worker forks (same as
// MARS_PROJECTS_FILE above).  The dir is minted inside the per-run TMPDIR root
// provisioned by global-teardown.ts, so it is auto-cleaned at teardown.
process.env.MARS_REPO = mkdtempSync(join(tmpdir(), `mars-test-repo-${process.pid}-`))

// ── Fail-fast guard ────────────────────────────────────────────────────────
//
// Detect the real repo's .mars path ONCE at setup time (before we redirect
// MARS_REPO).  After each test, assert that MARS_REPO (if set) does not point
// back at the live .mars — so a test that accidentally resets MARS_REPO to the
// live repo produces a loud, actionable failure instead of 2404 mysterious
// assertion errors.
//
// Detection uses the same --git-common-dir trick as detectRepoRoot() in
// context.ts: for a linked worktree the common git dir is the real repo's .git,
// so dirname gives the real repo root regardless of which worktree we are in.
let _realMarsDir: string | null = null
try {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  }).trim()
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  _realMarsDir = resolve(dirname(abs), '.mars')
} catch {
  // Not inside a git repo or git unavailable — skip the guard.
}
const REAL_MARS_DIR = _realMarsDir

if (REAL_MARS_DIR !== null) {
  beforeEach(() => {
    const marsRepo = process.env.MARS_REPO
    if (marsRepo === undefined || marsRepo === '') {
      // MARS_REPO deleted by the test — it is responsible for its own isolation
      // (e.g. context.test.ts, which explicitly chdir-s into a temp repo and
      // resets the context cache).  Skip the guard for this test.
      return
    }
    const candidateStateDir = resolve(marsRepo, '.mars')
    if (
      candidateStateDir === REAL_MARS_DIR ||
      candidateStateDir.startsWith(REAL_MARS_DIR + sep)
    ) {
      throw new Error(
        `[mars-test hermetic violation] MARS_REPO="${marsRepo}" resolves to ` +
          `the live .mars directory at "${REAL_MARS_DIR}". ` +
          `Set MARS_REPO to an isolated temp dir in your test's beforeEach, ` +
          `or rely on the global hermetic MARS_REPO set in test/setup-env.ts.`,
      )
    }
  })
}
