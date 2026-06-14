import { execFile } from 'node:child_process'
import { findProject } from '../../orchestrator/src/registry/projects.ts'

export type SpawnResult = { started: true } | { started: false; reason: string }

/** Function that starts or restarts a daemon for a given repoRoot and returns the outcome. */
export type Spawner = (repoRoot: string) => Promise<SpawnResult>

/**
 * Build a Spawner that runs `mars daemon <subcommand> --repo <repoRoot>` and
 * waits up to 10 s for it to exit.  Two call sites use this factory:
 *   - `spawnDaemon` ('start') — idempotent start; no-op when already running.
 *   - `restartDaemon` ('restart') — force-stops any running daemon then starts
 *     a fresh one; works even when the daemon is dead.
 */
const makeSpawner = (subcommand: 'start' | 'restart'): Spawner =>
  (repoRoot: string): Promise<SpawnResult> =>
    new Promise((resolve) => {
      execFile(
        'mars',
        ['daemon', subcommand, '--repo', repoRoot],
        { timeout: 10_000 },
        (err, _stdout, stderr) => {
          if (!err) {
            resolve({ started: true })
            return
          }
          const reason =
            err.signal != null
              ? `killed by signal ${err.signal}`
              : stderr?.trim() || err.message
          resolve({ started: false, reason })
        },
      )
    })

/**
 * Spawns `mars daemon start --repo <repoRoot>` detached and waits up to 10 s
 * for it to exit.  `mars daemon start` is idempotent — running it when the
 * daemon is already up is a no-op that exits 0, so a double-click is harmless.
 */
export const spawnDaemon: Spawner = makeSpawner('start')

/**
 * Spawns `mars daemon restart --repo <repoRoot>` and waits up to 10 s for it
 * to exit.  `mars daemon restart` force-stops any running daemon then starts a
 * fresh one; it is idempotent w.r.t. liveness — starting a fresh daemon when
 * none is running exits 0 just like a normal restart.
 */
export const restartDaemon: Spawner = makeSpawner('restart')

/**
 * Handler logic for POST /api/projects/:id/start.
 *
 * Exported so unit tests can inject a mock spawner without spinning up a full
 * HTTP server.  The route in index.ts wraps the returned {status, body} into a
 * Response.
 *
 * Security invariant: only the repoRoot registered in the project registry is
 * ever passed to the spawner — the request body and URL path contribute no
 * filesystem path.
 */
export async function handleProjectStart(
  projectId: string,
  spawner: Spawner = spawnDaemon,
): Promise<{ status: number; body: SpawnResult | { started: false; reason: string } }> {
  const entry = findProject(projectId)
  if (!entry) {
    return {
      status: 404,
      body: { started: false, reason: `unknown project: ${projectId}` },
    }
  }
  const result = await spawner(entry.repoRoot)
  return { status: 200, body: result }
}

/**
 * Handler logic for POST /api/projects/:id/restart.
 *
 * Mirrors handleProjectStart but runs `mars daemon restart` instead of
 * `mars daemon start`.  Works regardless of daemon liveness — no running daemon
 * needed to receive the request.
 *
 * Security invariant: only the repoRoot registered in the project registry is
 * ever passed to the spawner — the request body and URL path contribute no
 * filesystem path.
 */
export async function handleProjectRestart(
  projectId: string,
  spawner: Spawner = restartDaemon,
): Promise<{ status: number; body: SpawnResult | { started: false; reason: string } }> {
  const entry = findProject(projectId)
  if (!entry) {
    return {
      status: 404,
      body: { started: false, reason: `unknown project: ${projectId}` },
    }
  }
  const result = await spawner(entry.repoRoot)
  return { status: 200, body: result }
}
