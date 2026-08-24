/**
 * semaphore.ts — thin wrapper around the user-level, machine-global
 * semaphore at `~/.claude/bin/sem.mjs`.
 *
 * That semaphore coordinates resources Mars does not own exclusively: a
 * shared Playwright browser session that user-level Claude skills also
 * launch, and dev-server ports an interactive session may already be using.
 * Mars's own locks (`.mars/.merge.lock`, the awaiting-human lease) are
 * per-repo and intra-Mars, so they cannot serialize against a caller that
 * has neither a repo checkout nor the daemon running — hence shelling out
 * to a daemon-free, repo-free binary instead of building a lease subsystem
 * here.
 *
 * Design:
 *  - Never throws. A missing binary, a usage error, or a `--wait` timeout
 *    all degrade to a permit with `token: null` (i.e. "proceed without
 *    coordination") rather than failing the caller — the semaphore is
 *    advisory, so a broken or contended semaphore must not take a Mars
 *    task down with it.
 *  - `releaseSemaphore` on a `token: null` permit is a no-op — nothing was
 *    ever held.
 *  - A blocking wait surfaces the holder line sem.mjs already prints
 *    (`waiting on \`res\` — held by ...`) via `console.warn`, so a task
 *    stuck behind a user-held permit is legible instead of just slow.
 *
 * Test seam: when `MARS_TEST_SEMAPHORE=inproc` is set (test/setup-env.ts sets
 * it unconditionally for the whole vitest suite), `acquireSemaphore` never
 * shells out to sem.mjs — it hands back an always-granted in-process permit
 * instead, and `releaseSemaphore` no-ops on it. This is a defense-in-depth
 * seam: dev-server.ts's and browser-check.ts's own test suites already mock
 * this module at the `vi.mock('../semaphore', …)` level, but a caller that
 * reaches acquireSemaphore/releaseSemaphore through a real code path without
 * that module mock — today or in a future test — must still never contend
 * for, block on, or time out waiting on the real machine-global lock at
 * `~/.claude/semaphores/`. See {@link usesInProcMock} for the exact gate: a
 * caller that explicitly passes `binPath`/`env` (as semaphore.test.ts's real
 * round-trip suite does, sandboxed to a temp `SEM_ROOT`) opts out and still
 * exercises the genuine binary — that is the deliberate real-boundary test
 * for this wrapper.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { usesInProcSemaphoreMock } from '../config/tuning'

const execFileAsync = promisify(execFile)

const DEFAULT_BIN_PATH = join(homedir(), '.claude', 'bin', 'sem.mjs')

// Warn about a missing binary at most once per process — the caller may
// acquire/release many permits over a long-lived daemon run, and repeating
// the same warning on every one of them is noise, not signal.
let warnedMissingBinary = false

export interface AcquireSemaphoreOptions {
  /** Label recorded as the holder; shown in `sem status` and wait messages. */
  holder: string
  /** Permit ttl in seconds. Omit to use sem.mjs's own default (900s). */
  ttlSec?: number
  /** Seconds to wait for a free slot before giving up. Omit to not wait (0). */
  waitSec?: number
  /**
   * Process id to tie the permit's liveness to, for a long-lived holder
   * (e.g. a spawned dev server). When that pid dies, sem.mjs reclaims the
   * slot on the next acquire even if `releaseSemaphore` is never called.
   */
  pid?: number
  /** Override the path to sem.mjs. Defaults to `~/.claude/bin/sem.mjs`. Test seam. */
  binPath?: string
  /** Extra env vars merged over the ambient environment. Test seam for redirecting `SEM_ROOT`. */
  env?: NodeJS.ProcessEnv
}

export interface SemaphorePermit {
  resource: string
  /** Null when running degraded — no permit was actually acquired. */
  token: string | null
  /** The binPath/env used at acquire time, carried forward so release matches. */
  binPath: string
  env?: NodeJS.ProcessEnv
}

const resolveEnv = (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  env ? { ...process.env, ...env } : process.env

// Sentinel binPath carried on an in-process mock permit so releaseSemaphore
// can recognize it and no-op instead of trying to exec a real (nonexistent)
// binary at this path.
const IN_PROC_BIN_PATH = '<in-proc-test-semaphore>'

/**
 * True when this acquire call should use the in-process mock instead of the
 * real sem.mjs binary. Gated on both:
 *  - `MARS_TEST_SEMAPHORE=inproc` being set (test/setup-env.ts sets this
 *    unconditionally for the whole vitest suite; unset in production), and
 *  - the caller relying on default binPath/env resolution. A caller that
 *    explicitly overrides `binPath` or `env` has already steered itself away
 *    from the real machine-global lock (e.g. a fabricated nonexistent
 *    binPath, or a sandboxed `SEM_ROOT`) and knows what it is doing — it
 *    opts out of the mock and keeps exercising its own explicit target.
 */
const usesInProcMock = (opts: AcquireSemaphoreOptions): boolean =>
  usesInProcSemaphoreMock() &&
  opts.binPath === undefined &&
  opts.env === undefined

/**
 * Acquire a permit on a named resource of the user-level semaphore. See the
 * module doc for the degrade-to-no-op behaviour — this never throws.
 */
export async function acquireSemaphore(
  resource: string,
  opts: AcquireSemaphoreOptions,
): Promise<SemaphorePermit> {
  if (usesInProcMock(opts)) {
    // Always grants immediately — no subprocess, no lock file, no wait.
    return { resource, token: 'in-proc-mock-token', binPath: IN_PROC_BIN_PATH }
  }

  const binPath = opts.binPath ?? DEFAULT_BIN_PATH

  if (!existsSync(binPath)) {
    if (!warnedMissingBinary) {
      warnedMissingBinary = true
      console.warn(
        `semaphore: ${binPath} not found — Mars is running without machine-global coordination`,
      )
    }
    return { resource, token: null, binPath, env: opts.env }
  }

  const args = ['acquire', resource, '--holder', opts.holder]
  if (opts.ttlSec !== undefined) args.push('--ttl', String(opts.ttlSec))
  if (opts.waitSec !== undefined) args.push('--wait', String(opts.waitSec))
  if (opts.pid !== undefined) args.push('--pid', String(opts.pid))

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, ...args], {
      env: resolveEnv(opts.env),
    })
    // sem.mjs prints a "waiting on `res` — held by ..." line to stderr when
    // it had to block — surface it even on a successful acquire so a slow
    // task explains itself instead of just looking slow.
    if (stderr.trim()) console.warn(stderr.trim())
    const token = stdout.trim()
    return { resource, token: token || null, binPath, env: opts.env }
  } catch (err) {
    // Covers: exit 75 (full, --wait elapsed — EX_TEMPFAIL) and any other
    // failure (usage error, unexpected crash). All degrade the same way.
    const stderr = typeof (err as { stderr?: unknown }).stderr === 'string'
      ? (err as { stderr: string }).stderr.trim()
      : ''
    if (stderr) console.warn(stderr)
    console.warn(
      `semaphore: could not acquire \`${resource}\` — continuing without a permit (${(err as Error).message})`,
    )
    return { resource, token: null, binPath, env: opts.env }
  }
}

/**
 * Release a permit acquired via {@link acquireSemaphore}. No-op when the
 * permit's token is null (degraded mode, or the acquire itself failed) —
 * nothing was ever held, so there is nothing to free. Also a no-op for an
 * in-process mock permit (see the module doc) — nothing external was ever
 * held there either.
 */
export async function releaseSemaphore(permit: SemaphorePermit): Promise<void> {
  if (permit.token === null) return
  if (permit.binPath === IN_PROC_BIN_PATH) return
  try {
    await execFileAsync(
      process.execPath,
      [permit.binPath, 'release', permit.resource, permit.token],
      { env: resolveEnv(permit.env) },
    )
  } catch (err) {
    console.warn(`semaphore: failed to release \`${permit.resource}\`: ${(err as Error).message}`)
  }
}
