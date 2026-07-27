import { resolveDbTarget } from '../context.js'
import { openDb } from '../lib/db.js'
import { getProvider } from '../lib/deployment/registry.js'
import { patchOpenActionQueuePayload } from '../lib/action-queue.js'

/**
 * How often (ms) the sweeper polls `task_deployments` for pending rows.
 * Configurable via `MARS_DEPLOY_POLL_INTERVAL_MS`; defaults to 5 s.
 */
const DEPLOY_POLL_INTERVAL_MS = 5_000

/**
 * Start the deployment-status sweeper.  On each tick it:
 *  1. Marks any `pending` deployment older than 30 minutes as `failed`
 *     (error = "deploy timeout").
 *  2. For every remaining `pending` deployment it calls the registered
 *     provider's `status()` method and updates the row:
 *     - `ready`  → sets `status='ready'`, stores the URL, and patches the
 *                  corresponding awaiting-validation action-queue payload so
 *                  operators see the URL without restarting the daemon.
 *     - `failed` → sets `status='failed'` and records the provider error.
 *
 * Returns a `{ stop }` handle whose `stop()` cancels the interval.  The
 * interval is `.unref()`'d so it never prevents a clean daemon shutdown.
 */
export function startDeploymentStatusSweeper(opts?: {
  intervalMs?: number
}): { stop: () => void } {
  const envMs = Number(process.env.MARS_DEPLOY_POLL_INTERVAL_MS ?? '')
  const intervalMs = (Number.isFinite(envMs) && envMs > 0 ? envMs : null) ?? opts?.intervalMs ?? DEPLOY_POLL_INTERVAL_MS

  const handle = setInterval(() => {
    void sweepDeploymentStatus().catch(() => {
      // errors are non-fatal for the daemon
    })
  }, intervalMs)
  handle.unref()

  return { stop: () => clearInterval(handle) }
}

async function sweepDeploymentStatus(): Promise<void> {
  const dbTarget = resolveDbTarget()
  const client = openDb(dbTarget)

  try {
    // Step 1: expire stale pending deployments (> 30 minutes old).
    await client.execute(
      `UPDATE task_deployments
         SET status    = 'failed',
             error     = 'deploy timeout',
             updated_at = now()
       WHERE status     = 'pending'
         AND created_at <= now() - interval '30 minutes'`,
    )

    // Step 2: collect recent pending deployments to poll.
    const result = await client.execute(
      `SELECT deployment_id, task_id, provider
         FROM task_deployments
        WHERE status     = 'pending'
          AND created_at >  now() - interval '30 minutes'`,
    )

    for (const rawRow of result.rows) {
      const row = rawRow as unknown as {
        deployment_id: string
        task_id: string
        provider: string
      }

      const provider = getProvider(row.provider)
      if (!provider) continue

      try {
        const statusResult = await provider.status(row.deployment_id)

        if (statusResult.status === 'ready') {
          await client.execute({
            sql: `UPDATE task_deployments
                     SET status     = 'ready',
                         url        = ?,
                         updated_at = now()
                   WHERE deployment_id = ?`,
            args: [statusResult.url ?? null, row.deployment_id],
          })
          await patchOpenActionQueuePayload(row.task_id, {
            remoteUrl: statusResult.url,
          })
        } else if (statusResult.status === 'failed') {
          await client.execute({
            sql: `UPDATE task_deployments
                     SET status     = 'failed',
                         error      = ?,
                         updated_at = now()
                   WHERE deployment_id = ?`,
            args: [statusResult.error ?? null, row.deployment_id],
          })
        }
      } catch {
        // Per-deployment errors are non-fatal; continue sweeping the others.
      }
    }
  } finally {
    await client.close()
  }
}
