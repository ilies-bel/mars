/**
 * Vitest global teardown — reclaim leaked PGlite test clusters.
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
 * This teardown runs once, in the main process, after every worker has exited
 * (so the PGlite files are unlocked) and removes the clusters this run
 * created. It is scoped two ways so a concurrently-running daemon is never
 * affected: only known test-dir name prefixes, and only dirs born during this
 * run.
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Name prefixes used by the suite's `mkdtempSync(join(tmpdir(), ...))` calls.
// New DB-backed test helpers should keep the `mars-` (or `usage-src-`) prefix
// so they are cleaned up here automatically.
const TEST_TMP_PREFIXES = ['mars-', 'usage-src-'] as const

const RUN_START_ENV = '__MARS_TEST_RUN_START'

export function setup(): void {
  // Stamp the run start so teardown only removes dirs created by this run,
  // never a pre-existing dir owned by something else on the machine.
  process.env[RUN_START_ENV] = String(Date.now())
}

export function teardown(): void {
  const startedAt = Number(process.env[RUN_START_ENV] ?? 0)
  const base = tmpdir()

  let names: string[]
  try {
    names = readdirSync(base)
  } catch {
    return
  }

  for (const name of names) {
    if (!TEST_TMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue

    const full = join(base, name)
    try {
      const stat = statSync(full)
      if (!stat.isDirectory()) continue
      // 1 s slack absorbs clock granularity between setup() and dir creation.
      if (stat.birthtimeMs < startedAt - 1_000) continue
      rmSync(full, { recursive: true, force: true })
    } catch {
      // Best effort: a racing removal or a permission quirk must not fail the run.
    }
  }
}
