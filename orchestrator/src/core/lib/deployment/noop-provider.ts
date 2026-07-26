/**
 * NoopProvider — a deterministic in-memory DeploymentProvider for tests and
 * local development.  No network calls, no side effects.
 *
 * Behaviour contract:
 *   - deploy   returns status:'pending' and url:'https://noop.local/<taskId>'.
 *   - status   flips a pending deployment to 'ready' on the first call
 *              (deterministic single-call transition).
 *   - logs     returns a static diagnostic string.
 *   - teardown removes the deployment record; a second call is a silent no-op.
 */

import type { DeploymentProvider, DeployInput, DeployResult, StatusResult } from './provider'

interface DeploymentRecord {
  taskId: string
  url: string
  status: 'pending' | 'ready' | 'failed'
}

export class NoopProvider implements DeploymentProvider {
  private readonly deployments = new Map<string, DeploymentRecord>()

  deploy(input: DeployInput): Promise<DeployResult> {
    const deploymentId = `noop-${input.taskId}`
    const url = `https://noop.local/${input.taskId}`
    this.deployments.set(deploymentId, {
      taskId: input.taskId,
      url,
      status: 'pending',
    })
    return Promise.resolve({ deploymentId, url, status: 'pending' })
  }

  status(deploymentId: string): Promise<StatusResult> {
    const record = this.deployments.get(deploymentId)
    if (record === undefined) {
      return Promise.resolve({ status: 'failed', url: null, error: `unknown deployment: ${deploymentId}` })
    }
    // Single-call pending → ready transition.
    if (record.status === 'pending') {
      record.status = 'ready'
    }
    return Promise.resolve({ status: record.status, url: record.url })
  }

  logs(deploymentId: string): Promise<string> {
    const known = this.deployments.has(deploymentId)
    return Promise.resolve(
      known
        ? `[noop] deployment ${deploymentId} — no real logs (NoopProvider)`
        : `[noop] deployment ${deploymentId} not found`,
    )
  }

  teardown(deploymentId: string): Promise<void> {
    // Idempotent: delete is a no-op when the key is absent.
    this.deployments.delete(deploymentId)
    return Promise.resolve()
  }
}
