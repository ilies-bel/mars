/**
 * Real dependencies for `createBaselineRepairer` — the daemon's production
 * wiring for `src/core/lib/baseline-repair.ts`.
 *
 * Before this module existed, `createBaselineRepairer` was fully implemented
 * and unit-tested via injected fakes, but nothing in the daemon ever
 * constructed it with real git/fs/npm/action-queue dependencies — `npm run
 * knip` flagged `baseline-repair.ts` itself as an unused file. A real broken
 * baseline (an unsatisfiable version pin merged into `package.json`, the
 * incident that motivated the whole actor) paused dispatch via
 * `baseline-health.ts` but could never be auto-repaired.
 *
 * This module supplies the real deps; `server.ts` constructs the repairer
 * once at startup (mirroring `createBaselineHealthChecker`'s construction)
 * and triggers `.repair()` whenever the baseline health checker reports the
 * integration branch poisoned. `createBaselineRepairer` itself already
 * bounds the privilege (file allowlist, diff cap, one-attempt-then-escalate,
 * never `git push`) — see that module's docstring for the full contract.
 *
 * Dynamic imports throughout, matching the style already used for
 * `createBaselineHealthChecker`'s deps in `server.ts` — this module is
 * constructed once at daemon startup, not on a hot path, so the import cost
 * is paid once and circular-import risk with the rest of `core/` stays low.
 */

import type { PauseController } from './pause-state'
import type { BaselineRepairDeps, BaselineRepairer } from '../lib/baseline-repair'
import { createBaselineRepairer } from '../lib/baseline-repair'
import { baselineRepairNpmViewTimeoutMs } from '../config/tuning'

export interface CreateRealBaselineRepairerOptions {
  /** The integration-branch checkout the repair runs in. Never a worktree. */
  repoRoot: string
  /** The branch the repair is allowed to commit to. */
  integrationBranch: string
  /** The daemon's shared dispatch-pause controller. */
  pause: PauseController
  log?: (msg: string) => void
  /**
   * Timeout for the `npm view <pkg> versions --json` registry lookup.
   * Defaults to {@link baselineRepairNpmViewTimeoutMs} (the
   * `MARS_BASELINE_REPAIR_NPM_VIEW_TIMEOUT_MS` knob, resolved in
   * `../config/tuning.ts` — the one directory allowed to read environment
   * variables directly), so this module never touches the ambient
   * environment itself. `server.ts` passes an explicit value resolved off
   * its own injected env.
   */
  npmViewTimeoutMs?: number
}

/**
 * Build a {@link BaselineRepairer} wired to real git, real fs, a real `npm
 * view` registry lookup, the real Fixer Worker (run in place, no worktree),
 * and the real action queue / pause controller.
 */
export const createRealBaselineRepairer = (
  opts: CreateRealBaselineRepairerOptions,
): BaselineRepairer => {
  const { repoRoot, integrationBranch, pause, log } = opts
  const npmViewTimeoutMs = opts.npmViewTimeoutMs ?? baselineRepairNpmViewTimeoutMs()

  const deps: BaselineRepairDeps = {
    repoRoot,
    integrationBranch,

    // Same non-mutating frozen-install probe the baseline-health checker
    // uses, shared via worktree-install.ts so the two never drift.
    probeInstall: async () => {
      const { probeFrozenInstall } = await import('../lib/worktree-install')
      return probeFrozenInstall(repoRoot)
    },

    // Run the Fixer Worker IN PLACE at repoRoot — no worktree, no branch.
    // This is the one place in the daemon a Worker is dispatched directly
    // against the integration checkout instead of a task worktree.
    runAgentInPlace: async (prompt) => {
      const { Workers } = await import('../workers')
      const result = await Workers.Fixer.run(prompt, { cwd: repoRoot })
      return { exitCode: result.exitCode }
    },

    // Shell out to git in repoRoot. execProbe never throws on a non-zero
    // exit (the repairer reads exitCode itself); a genuine spawn failure
    // (missing binary, deleted cwd) still throws, same as every other git
    // caller in this codebase.
    git: async (argv) => {
      const { execProbe } = await import('../lib/git/internal')
      const [cmd, ...rest] = argv
      return execProbe(cmd, rest, { cwd: repoRoot })
    },

    readFile: async (relPath) => {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      return readFile(join(repoRoot, relPath), 'utf8')
    },
    writeFile: async (relPath, content) => {
      const { writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      await writeFile(join(repoRoot, relPath), content, 'utf8')
    },

    // `npm view <pkg> versions --json`, with a timeout and a graceful
    // empty-array fallback on any failure (missing binary, registry
    // outage, malformed output, timeout). Per the module's own contract:
    // an empty array means "no data", not "nothing is published" —
    // `resolveManifestVersion` treats it as unresolved rather than
    // guessing, so a fallback here can never produce a wrong version, only
    // a more conservative escalation.
    listPublishedVersions: async (packageName) => {
      const { execProbe } = await import('../lib/git/internal')
      let result: { exitCode: number; stdout: string; stderr: string }
      try {
        result = await execProbe('npm', ['view', packageName, 'versions', '--json'], {
          cwd: repoRoot,
          timeout: npmViewTimeoutMs,
        })
      } catch {
        return []
      }
      if (result.exitCode !== 0) return []
      try {
        const parsed: unknown = JSON.parse(result.stdout)
        if (Array.isArray(parsed)) {
          return parsed.filter((v): v is string => typeof v === 'string')
        }
        if (typeof parsed === 'string') return [parsed]
        return []
      } catch {
        return []
      }
    },

    // Raised as a 'health-check-alert' — a decision-class action-queue row
    // (ADR-0094): unlike 'baseline-broken' (a condition kind, derived on
    // read from the health checker's live poison state), the REFUSAL
    // reason a repair attempt produces is operator-authored content that
    // cannot be recomputed from live state, so it needs a stored row an
    // operator explicitly resolves.
    raise: async (item) => {
      const { raiseActionQueueItem } = await import('../lib/action-queue')
      return raiseActionQueueItem({
        kind: 'health-check-alert',
        category: 'daemon',
        priority: 'high',
        title: item.title,
        body: item.body,
        payload: {
          conditionKey: 'baseline-repair',
          message: item.title,
          checkDetails: item.payload,
        },
        context: {},
        raisedBy: 'daemon:baseline-repair',
        signature: item.signature,
      })
    },

    // Mirrors baseline-health.ts's own recovery logic: only resume when the
    // CURRENT pause reason is 'baseline' — never stomp an unrelated
    // operator/storm/quota pause that happens to be in effect too.
    clearBaselinePause: () => {
      if (pause.get().reason === 'baseline') pause.resume()
    },

    log,
  }

  return createBaselineRepairer(deps)
}
