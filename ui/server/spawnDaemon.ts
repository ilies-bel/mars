import { execFile } from 'node:child_process'
import { findProject } from '../../orchestrator/src/registry/projects.ts'

export type SpawnResult = { started: true } | { started: false; reason: string }

/** Function that starts a daemon for a given repoRoot and returns the outcome. */
export type Spawner = (repoRoot: string) => Promise<SpawnResult>

/**
 * Spawns `mars daemon start --repo <repoRoot>` detached and waits up to 10 s for
 * it to exit.  `mars daemon start` is idempotent — running it when the daemon is
 * already up is a no-op that exits 0, so a double-click is harmless.
 */
export const spawnDaemon: Spawner = (repoRoot: string): Promise<SpawnResult> =>
  new Promise((resolve) => {
    execFile(
      'mars',
      ['daemon', 'start', '--repo', repoRoot],
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
