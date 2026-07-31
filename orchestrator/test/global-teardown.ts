/**
 * Vitest global setup/teardown — reclaim leaked PGlite test clusters.
 *
 * Many suites spin up an isolated database by doing
 * `mkdtempSync(join(tmpdir(), '<prefix>-'))` and opening a PGlite-backed
 * client against it (see `src/core/lib/__tests__/*`). Each cluster is a full
 * Postgres data directory (~40 MB, hundreds of files) and the tests never
 * remove it. A single `vitest run` leaks a few hundred; the orchestrator's
 * per-task `verify` step runs `vitest run` inside every worktree, so across
 * many tasks the OS temp dir accumulated tens of thousands of clusters
 * (~400 GB / ~13 M files observed on 2026-07-23).
 *
 * ## Why this is not a `mars-*` glob sweep
 *
 * The previous implementation scanned `$TMPDIR` for well-known name prefixes
 * and deleted every match born after the run started. That is safe for a single
 * run and actively destructive for concurrent ones — which is the normal state
 * of this repo, since the daemon dispatches tasks whose `verify` step runs
 * `vitest` while a developer is running `vitest` too. Run B's fixtures are
 * `mars-*` and are born after run A started, so run A's teardown deletes run B's
 * live Postgres data directories mid-test. The symptom is a crop of
 * unreproducible `fatal: Unable to read current working directory`,
 * `could not open file "base/5/…"`, and bare `ErrnoError` failures that look
 * like flakes but are one run wiping another's disk.
 *
 * The fix is containment, not a smarter filter: `setup()` mints a private temp
 * root for this run and points `$TMPDIR` at it, so every `os.tmpdir()` call in
 * every worker (forks inherit the env) lands *inside* that root. `teardown()`
 * then removes exactly one path — its own root. No run can name, match, or
 * reach another run's directories, whatever the fixture prefixes are.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Prefix for the per-run temp roots.
 *
 * Deliberately does NOT start with `mars-` or `usage-src-`. Those are the two
 * prefixes the previous blanket sweep matched, and older checkouts of this repo
 * still run that sweep — a stale worktree, a consumer install, or simply the
 * daemon dispatching tasks off a pre-fix `main`. A root named `mars-vt-*` is a
 * `mars-*` match born during their run, so their teardown deletes it and takes
 * this run's entire fixture tree with it (observed: nine concurrent daemon
 * suites wiping the root within seconds of creation). Staying outside their
 * glob makes this run's root invisible to them.
 *
 * Kept short so the absolute paths beneath it stay well clear of the 104-byte
 * unix-socket path limit on macOS, which a `MARS_DB_BACKEND=embedded` run needs.
 */
const RUN_ROOT_PREFIX = 'vt-mars-'

/** Env var carrying this run's private temp root from `setup()` to `teardown()`. */
const RUN_ROOT_ENV = '__MARS_TEST_RUN_ROOT'

/**
 * Age past which a `mars-vt-*` root is considered abandoned by a crashed or
 * SIGKILL-ed run and is safe to reclaim. Deliberately far longer than any real
 * suite (minutes), so an in-flight run's root is never a candidate.
 */
const ABANDONED_ROOT_AGE_MS = 6 * 60 * 60 * 1000

/** Best-effort recursive delete; never throws. */
const removeQuietly = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // A racing removal or a permission quirk must not fail the run.
  }
}

/**
 * Reclaim run roots left behind by runs that died before their teardown.
 *
 * Safe under concurrency because the age gate is measured in hours: a root that
 * old cannot belong to a suite that is still executing. Never touches bare
 * `mars-*` fixture dirs — those are always nested inside some run's root.
 */
const sweepAbandonedRoots = (base: string, ownRoot: string): void => {
  let names: string[]
  try {
    names = readdirSync(base)
  } catch {
    return
  }

  const cutoff = Date.now() - ABANDONED_ROOT_AGE_MS
  for (const name of names) {
    if (!name.startsWith(RUN_ROOT_PREFIX)) continue
    const full = join(base, name)
    if (full === ownRoot) continue
    try {
      const stat = statSync(full)
      if (!stat.isDirectory()) continue
      if (stat.birthtimeMs >= cutoff) continue
      removeQuietly(full)
    } catch {
      // Best effort.
    }
  }
}

export function setup(): void {
  // Mint a temp root owned exclusively by this run and redirect $TMPDIR into
  // it. `os.tmpdir()` re-reads the env on every call, and the forks pool is
  // created after globalSetup, so every worker's fixtures land under this root.
  const systemTmp = tmpdir()
  const runRoot = mkdtempSync(join(systemTmp, RUN_ROOT_PREFIX))

  process.env[RUN_ROOT_ENV] = runRoot
  process.env.TMPDIR = runRoot
  // Non-POSIX fallbacks Node consults on other platforms.
  process.env.TMP = runRoot
  process.env.TEMP = runRoot
}

export function teardown(): void {
  const runRoot = process.env[RUN_ROOT_ENV]
  if (runRoot === undefined || runRoot === '') return

  // Restore $TMPDIR before deleting, so anything running later in this process
  // does not resolve temp paths into a directory that is about to disappear —
  // and so `tmpdir()` below names the *system* temp dir (where the run roots
  // live), not this run's root.
  delete process.env.TMPDIR
  delete process.env.TMP
  delete process.env.TEMP

  // Exactly one path: this run's own root. Other runs are unreachable by
  // construction.
  removeQuietly(runRoot)

  sweepAbandonedRoots(tmpdir(), runRoot)
}
