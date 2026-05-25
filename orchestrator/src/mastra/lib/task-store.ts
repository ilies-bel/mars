import type { Client, InStatement, ResultSet } from '@libsql/client'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TaskStatus } from '../queue'

const execFileAsync = promisify(execFile)

/**
 * Rollup verdict for an arc of tasks sharing one `origin_id`. See
 * {@link TaskStore.arcStatus} for the predicate semantics.
 *
 *   - `'in-progress'`: at least one task is in a non-terminal status.
 *   - `'arc-done'`   : every task is terminal AND at least one reached
 *                      `'done'` (so the arc actually landed work).
 *   - `'arc-failed'` : every task is terminal but none reached `'done'`
 *                      (everything was dropped or failed).
 */
export type ArcRollupStatus = 'in-progress' | 'arc-done' | 'arc-failed'

export interface ArcTaskSummary {
  id: string
  status: TaskStatus
}

export interface ArcStatus {
  status: ArcRollupStatus
  tasks: ArcTaskSummary[]
  /**
   * Commit SHAs on the integration branch attributable to this arc, in
   * the order `git log` returns them on that branch (most-recent first
   * from git, reversed here so commit order matches arc progression).
   * Best-effort — when no integration branch / repo is reachable from
   * `cwd`, this is `[]`.
   */
  landedCommits: string[]
}

export interface ArcStatusOptions {
  /** Defaults to `'main'`. */
  integrationBranch?: string
  /** Defaults to `process.env.MARS_REPO`. */
  cwd?: string
}

/**
 * Terminal statuses for the arc rollup. A task in any of these counts
 * as "settled" for the predicate; only `'done'` counts as a landed
 * outcome (per the AC, dropped/failed are terminal but not landed).
 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'done',
  'failed',
  'dropped',
])

/**
 * Deep seam over `.mars/queue.db`. Per ADR-0021 the TaskStore is the only
 * interface lib/cousin modules use to reach queue data — the raw libsql
 * `Client` never crosses the seam.
 *
 * This first slice introduces TaskStore as a minimal pass-through:
 *
 * - `query` is the read-only side door (SELECTs). Today it shares a code
 *   path with `execute`; a later slice tightens it to libsql's `'read'`
 *   mode so write attempts fail closed.
 * - `execute` is the single-statement write side door.
 * - `arcStatus` is the per-arc rollup predicate added in slice 1 of PRD
 *   9aec85db. Stateless: every call recomputes from the tasks table.
 *
 * `atomic(fn)` (callback-scoped multi-statement transactions) and the
 * remaining typed domain methods land in subsequent slices.
 */
export interface TaskStore {
  query(stmt: InStatement): Promise<ResultSet>
  execute(stmt: InStatement): Promise<ResultSet>
  arcStatus(originId: string, opts?: ArcStatusOptions): Promise<ArcStatus>
}

/**
 * Wrap an existing libsql `Client` as a `TaskStore`. Used at the composition
 * root for production wiring, and in tests over an in-memory client.
 */
export const createLibsqlTaskStore = (client: Client): TaskStore => ({
  query: (stmt) => client.execute(stmt),
  execute: (stmt) => client.execute(stmt),
  arcStatus: async (originId, opts) => {
    const r = await client.execute({
      sql: `SELECT id, status FROM tasks
              WHERE origin_id = ?
              ORDER BY created_at ASC`,
      args: [originId],
    })
    const tasks: ArcTaskSummary[] = r.rows.map((row) => {
      const r0 = row as unknown as { id: string; status: string }
      return { id: r0.id, status: r0.status as TaskStatus }
    })

    let status: ArcRollupStatus
    if (tasks.length === 0) {
      // An origin with no rows is treated as in-progress: the arc has
      // been declared but nothing has been derived yet. Avoids silently
      // calling an empty proposal "done".
      status = 'in-progress'
    } else {
      const allTerminal = tasks.every((t) => TERMINAL_STATUSES.has(t.status))
      if (!allTerminal) {
        status = 'in-progress'
      } else {
        const anyDone = tasks.some((t) => t.status === 'done')
        status = anyDone ? 'arc-done' : 'arc-failed'
      }
    }

    const landedCommits = await readLandedCommits(originId, opts)
    return { status, tasks, landedCommits }
  },
})

/**
 * Best-effort read of integration-branch commits attributable to this
 * arc. Uses `git log --grep` so any commit whose message references the
 * origin_id (e.g. via a trailer or recovery commit subject) is picked
 * up. When the cwd is not a git repo, or the integration branch does
 * not resolve, returns `[]` — the rollup predicate above is the
 * authoritative signal; landedCommits is a presentational add-on.
 */
const readLandedCommits = async (
  originId: string,
  opts?: ArcStatusOptions,
): Promise<string[]> => {
  const cwd = opts?.cwd ?? process.env.MARS_REPO
  if (!cwd) return []
  const integrationBranch = opts?.integrationBranch ?? 'main'
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        integrationBranch,
        `--grep=${originId}`,
        '--fixed-strings',
        '--format=%H',
      ],
      { cwd },
    )
    const shas = stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    // `git log` lists most-recent-first; reverse so the returned list
    // reads as commit order (oldest → newest) which matches how the arc
    // progressed over time.
    return shas.reverse()
  } catch {
    return []
  }
}

let cachedDefaultStore: TaskStore | null = null

/**
 * Composition-root convenience: lazily run the queue migrations, then return
 * a TaskStore backed by the queue module's singleton client. Callers that
 * already receive a TaskStore via dependency injection (the eventual end
 * state per ADR-0021) should ignore this helper.
 *
 * Exists during the migration so call sites can drop their direct
 * `getClient()/initQueue()` imports without simultaneously rewiring the
 * composition root.
 */
export const getDefaultTaskStore = async (): Promise<TaskStore> => {
  if (cachedDefaultStore) return cachedDefaultStore
  const { initQueue, getClient } = await import('../queue')
  await initQueue()
  cachedDefaultStore = createLibsqlTaskStore(getClient())
  return cachedDefaultStore
}

/**
 * Test-only: drop the cached default store so a subsequent
 * `getDefaultTaskStore()` rebuilds against whatever queue client is current.
 */
export const __resetDefaultTaskStoreForTests = (): void => {
  cachedDefaultStore = null
}
