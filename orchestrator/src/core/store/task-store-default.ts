/**
 * Composition-root accessors for the default (production) `DomainTaskStore`.
 *
 * Extracted from `task-store.ts` so that modules can import these accessors
 * without pulling in the full internal `task-store.ts` module, which imports
 * `Arc` and many queue functions. This leaf module has no reverse dependency
 * on `arc.ts` or `queue.ts` — only on `task-store.ts` (for `createTaskStore`
 * and the `DomainTaskStore` type) and on dependency-free leaves
 * (`lib/pg-schema`, `lib/queue-client`). See ADR-0101 edge 2.
 *
 * `task-store.ts` is unaffected: it still does not need to know this module
 * exists. Call sites that previously reached these accessors through
 * `task-store.ts` import them from here instead.
 */

import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'

import { ensureSchema } from '../lib/pg-schema.js'
import { resolveQueueClient } from '../lib/queue-client.js'
import type { DbClient } from '../lib/db.js'
import { createTaskStore } from './task-store'
import type { DomainTaskStore } from './task-store'

export type { DomainTaskStore } from './task-store'

// ─── Cross-boundary write guard helper ───────────────────────────────────────

/**
 * Compute the candidate `.mars/` stateDir for cross-boundary guard checks
 * WITHOUT calling `resolveContext()` (which has a `mkdirSync` side effect).
 *
 * - When `MARS_REPO` is explicitly set, derive stateDir from it directly.
 * - When `MARS_REPO` is absent and the CWD sits inside a worktree, infer the
 *   parent `.mars/` from the CWD path (the worktree path always contains
 *   `/.mars/worktrees/<id>`).
 * - Returns `null` when neither source is available (ordinary production daemon
 *   without an explicit repo binding — guard skips in that case).
 */
const computeStateDirForGuard = (): string | null => {
  const marsRepo = process.env.MARS_REPO
  if (marsRepo) return resolve(marsRepo) + sep + '.mars'

  const cwd = process.cwd()
  const marker = sep + '.mars' + sep + 'worktrees' + sep
  const idx = cwd.indexOf(marker)
  if (idx !== -1) return cwd.slice(0, idx) + sep + '.mars'

  return null
}

let cachedDefaultStore: DomainTaskStore | null = null

// ─── Public accessors ─────────────────────────────────────────────────────────

/**
 * Composition-root accessor: the single process-wide `DomainTaskStore` over
 * the Mars database. Lazily ensures the canonical schema and constructs the
 * store around the seam-internal client. This is the only sanctioned way for
 * production modules to obtain a store when one was not threaded in via DI.
 *
 * Two cross-boundary write guards are applied on the default-resolution path
 * BEFORE `resolveContext()` (which has a `mkdirSync` side effect) is called:
 *
 * 1. **Worktree guard**: if the process CWD is inside the SAME
 *    `<stateDir>/worktrees/<id>/` as the store would resolve to, we are a
 *    dispatched Worker about to contaminate the PARENT production database
 *    (forensic incident 2026-07-02). The stateDir is computed without side
 *    effects so this throws before any filesystem mutation.
 *
 * 2. **Vitest guard**: when running under vitest (`process.env.VITEST`) with
 *    `MARS_REPO` explicitly set, the resolved `.mars/` must reside inside the
 *    OS temp directory. A non-temp `MARS_REPO` means the test forgot to use an
 *    isolated store and would write to a real database. Use `createTaskStore()`
 *    or set `MARS_REPO` to a `mkdtempSync()` path.
 */
export const getDefaultTaskStore = async (): Promise<DomainTaskStore> => {
  if (cachedDefaultStore) return cachedDefaultStore

  const cwd = process.cwd()
  const stateDir = computeStateDirForGuard()

  if (stateDir !== null) {
    // ── Guard 1: worktree cross-boundary write prevention ──────────────────
    // Only fires when stateDir was INFERRED from CWD (i.e. MARS_REPO is not
    // explicitly set). When MARS_REPO is set — or when --repo was propagated
    // into MARS_REPO by makeProductionDeps() — the caller deliberately chose
    // the target repo and the guard must not block them. The guard is a
    // foot-gun protector for implicit CWD resolution, not an absolute veto.
    if (!process.env.MARS_REPO && cwd.startsWith(stateDir + sep + 'worktrees' + sep)) {
      throw new Error(
        `[mars] getDefaultTaskStore() refused: process CWD is inside a worktree ` +
          `(${cwd}). This would write to the PARENT repo's production database ` +
          `(resolved via ${stateDir}). ` +
          `Use createTaskStore() with an isolated client, or inject the store via DI.`,
      )
    }

    // ── Guard 2: vitest hermetic store enforcement ─────────────────────────
    // Only applies when VITEST is running, blocking non-temp stores before
    // any write reaches the DB.
    if (process.env.VITEST) {
      const td = tmpdir()
      if (!stateDir.startsWith(td + sep) && !stateDir.startsWith(td + '/')) {
        throw new Error(
          `[mars] getDefaultTaskStore() resolved to ${stateDir} which is NOT ` +
            `inside the system temp directory (${td}). ` +
            `Tests must use an isolated store: set MARS_REPO to a mkdtempSync() path ` +
            `or use createTaskStore() with an isolated client.`,
        )
      }
    }
  }

  await ensureSchema(resolveQueueClient())
  cachedDefaultStore = createTaskStore(resolveQueueClient())
  return cachedDefaultStore
}

/**
 * Synchronous composition-root accessor for call sites that only need domain
 * methods and cannot await. The schema is expected to exist already — the
 * daemon (and every init flow) runs `ensureSchema` at startup.
 *
 * Applies the same worktree cross-boundary guard as {@link getDefaultTaskStore}
 * to prevent dispatched Workers from writing to the parent production database.
 * The guard is skipped when `MARS_REPO` is explicitly set (or has been set by
 * `makeProductionDeps()` from a `--repo` flag) — explicit bindings are
 * intentional and must not be blocked.
 */
export const getDefaultDomainTaskStore = (): DomainTaskStore => {
  const cwd = process.cwd()
  // Guard only fires for the implicit/CWD-inferred path. An explicit MARS_REPO
  // (set directly or propagated from --repo by makeProductionDeps) signals that
  // the caller deliberately chose the target repo; honor that and skip the guard.
  if (!process.env.MARS_REPO) {
    const stateDir = computeStateDirForGuard()
    if (stateDir !== null && cwd.startsWith(stateDir + sep + 'worktrees' + sep)) {
      throw new Error(
        `[mars] getDefaultDomainTaskStore() refused: process CWD is inside a worktree ` +
          `(${cwd}). This would write to the PARENT repo's production database ` +
          `(resolved via ${stateDir}). ` +
          `Use createTaskStore() with an isolated client, or inject the store via DI.`,
      )
    }
  }
  return createTaskStore(resolveQueueClient())
}

/**
 * Composition-root-only access to the underlying `DbClient` for the
 * wire-bus / outbox subscriber layer (cursor reads on the `events` table,
 * which lives below the domain seam — ADR-0021 keeps the Outbox in the same
 * database).
 *
 * This is NOT a domain escape hatch: domain modules must use the store. The
 * only sanctioned importer is the daemon composition root, which threads this
 * client into `ensure*`/`drain*` subscriber wiring. Returning the raw client
 * here is the ADR's "constructor injection of a DB client at the composition
 * root" — the leak the ADR closes is *domain* modules importing a raw
 * `getClient`, not the root wiring the bus.
 */
export const getCompositionRootClient = (): DbClient => resolveQueueClient()

/**
 * Composition-root migration entry point. Applies the canonical schema
 * (`ensureSchema`, idempotent). The daemon calls this once at startup so the
 * schema exists before any subscriber or store touches the DB.
 */
export const runCompositionRootMigrations = (): Promise<void> =>
  ensureSchema(resolveQueueClient())

/**
 * Test-only: drop the cached default store so a subsequent
 * `getDefaultTaskStore()` rebuilds against whatever queue client is current.
 */
export const __resetDefaultTaskStoreForTests = (): void => {
  cachedDefaultStore = null
}
