/**
 * Deployment teardown helper — best-effort decommissioning of all active
 * preview deployments for a task.
 *
 * Called by the four terminal-resolution paths in the task lifecycle:
 *   - validate   (coreValidateTask)
 *   - reject     (coreRejectTask)
 *   - merge done (updateTask status → 'done')
 *   - drop/purge (corePurgeTask)
 *
 * Errors from the provider are caught, logged, and never rethrown so they
 * cannot block the terminal state transition of the task.
 */

import { resolveStateClient } from '../../store/state-client.js'
import { getProvider } from './registry.js'

/**
 * Tear down every active (not yet torn-down) deployment for `taskId`.
 *
 * For each deployment row where `torn_down_at IS NULL`:
 *   1. Resolve the registered `DeploymentProvider` for the deployment's
 *      `provider` key.
 *   2. Call `provider.teardown(deploymentId)`.
 *   3. On success, stamp `torn_down_at = now()` on the row so the call is
 *      idempotent — a repeated teardown for the same deployment is a no-op.
 *   4. On any error (missing provider, provider throw, DB write failure):
 *      log with `console.error('[deployment:teardown] ...')` and continue
 *      to the next deployment.  Never rethrows.
 */
export async function teardownDeploymentsForTask(taskId: string): Promise<void> {
  const client = resolveStateClient()

  let rows: Array<{ deployment_id: string; provider: string }>
  try {
    const result = await client.execute({
      sql: `SELECT deployment_id, provider FROM task_deployments
            WHERE task_id = ? AND torn_down_at IS NULL`,
      args: [taskId],
    })
    rows = result.rows as unknown as Array<{ deployment_id: string; provider: string }>
  } catch (err) {
    console.error(
      `[deployment:teardown] failed to list deployments for task ${taskId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return
  }

  for (const row of rows) {
    const { deployment_id: deploymentId, provider: providerKey } = row

    const provider = getProvider(providerKey)
    if (!provider) {
      console.error(
        `[deployment:teardown] no provider registered for key "${providerKey}" — skipping teardown of deployment ${deploymentId} (task ${taskId})`,
      )
      continue
    }

    try {
      await provider.teardown(deploymentId)
    } catch (err) {
      console.error(
        `[deployment:teardown] provider.teardown failed for deployment ${deploymentId} (task ${taskId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      // Do not mark torn_down_at so a retry can attempt teardown again.
      continue
    }

    try {
      await client.execute({
        sql: `UPDATE task_deployments
              SET torn_down_at = now(), updated_at = now()
              WHERE deployment_id = ?`,
        args: [deploymentId],
      })
    } catch (err) {
      console.error(
        `[deployment:teardown] failed to stamp torn_down_at for deployment ${deploymentId} (task ${taskId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
