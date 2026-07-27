/**
 * HttpDeploymentProvider — a concrete DeploymentProvider that talks to a
 * remote deployment REST API.
 *
 * HTTP seam: every outgoing call is routed through `fetchImpl`, which
 * defaults to the global `fetch`.  Tests inject a stub via the constructor
 * so no live network calls are needed.
 *
 * API surface assumed:
 *   POST   /deployments           → { id, url?, status? }
 *   GET    /deployments/:id       → { status?, url?, error? }
 *   GET    /deployments/:id/logs  → plain text
 *   DELETE /deployments/:id       → any 2xx / 4xx / 5xx (all ignored)
 */

import type { DeploymentProvider, DeployInput, DeployResult, StatusResult, DeploymentStatus } from './provider'

export interface HttpDeploymentProviderOptions {
  /** Base URL of the deployment API, e.g. https://deploy.example.com */
  endpoint: string
  /** API token sent as `Authorization: Bearer <token>` on every request. */
  token: string
  /**
   * Fetch implementation to use.  Defaults to the global `fetch`.
   * Pass a stub here in tests to avoid live HTTP calls.
   */
  fetchImpl?: typeof fetch
}

export class HttpDeploymentProvider implements DeploymentProvider {
  private readonly endpoint: string
  private readonly token: string
  private readonly fetch: typeof fetch

  constructor(opts: HttpDeploymentProviderOptions) {
    this.endpoint = opts.endpoint.replace(/\/$/, '')
    this.token = opts.token
    this.fetch = opts.fetchImpl ?? globalThis.fetch
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const res = await this.fetch(`${this.endpoint}/deployments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        branch: input.branch,
        env: input.env,
        taskId: input.taskId,
      }),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} deploying task ${input.taskId}`)
    }

    const data = (await res.json()) as { id: string; url?: string | null; status?: string }
    return {
      deploymentId: data.id,
      url: data.url ?? null,
      status: mapProviderStatus(data.status),
    }
  }

  async status(deploymentId: string): Promise<StatusResult> {
    const res = await this.fetch(`${this.endpoint}/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })

    if (!res.ok) {
      return { status: 'failed', url: null, error: `HTTP ${res.status}` }
    }

    const data = (await res.json()) as { status?: string; url?: string | null; error?: string }
    const result: StatusResult = {
      status: mapProviderStatus(data.status),
      url: data.url ?? null,
    }
    if (data.error !== undefined) {
      result.error = data.error
    }
    return result
  }

  async logs(deploymentId: string): Promise<string> {
    const res = await this.fetch(`${this.endpoint}/deployments/${deploymentId}/logs`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching logs for ${deploymentId}`)
    }

    return res.text()
  }

  async teardown(deploymentId: string): Promise<void> {
    // Idempotent contract: never throw regardless of HTTP status or network error.
    try {
      await this.fetch(`${this.endpoint}/deployments/${deploymentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.token}` },
      })
    } catch {
      // Swallow errors — teardown must be a silent no-op for any id.
    }
  }
}

/**
 * Map a provider-specific status string to the canonical DeploymentStatus
 * union.  Unknown or absent values map to 'failed' so the caller always
 * receives a well-typed value.
 */
function mapProviderStatus(providerStatus: string | undefined): DeploymentStatus {
  switch (providerStatus) {
    case 'pending':
    case 'building':
    case 'queued':
      return 'pending'
    case 'ready':
    case 'success':
    case 'live':
      return 'ready'
    default:
      return 'failed'
  }
}
