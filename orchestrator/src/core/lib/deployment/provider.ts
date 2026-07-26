/**
 * DeploymentProvider — the contract every remote-environment provider must
 * satisfy. A deployment represents a live preview environment spun up for a
 * specific task's worktree so a human can do manual QA before the merge gate.
 *
 * The four methods mirror the lifecycle of a remote preview environment:
 *   1. deploy   — provision the environment from a worktree,
 *   2. status   — poll readiness,
 *   3. logs     — stream build/runtime output for diagnosis,
 *   4. teardown — decommission the environment (idempotent).
 */

export interface DeployInput {
  /** The Mars task id this deployment is associated with. */
  taskId: string
  /** Absolute path to the task's git worktree on disk. */
  worktreePath: string
  /** The git branch being deployed. */
  branch: string
  /** Extra environment variables to inject into the deployment runtime. */
  env: Record<string, string>
}

export type DeploymentStatus = 'pending' | 'ready' | 'failed'

export interface DeployResult {
  /** Provider-assigned opaque deployment id (used in subsequent calls). */
  deploymentId: string
  /** Public URL of the preview environment, or null when not yet assigned. */
  url: string | null
  /** Readiness state immediately after deploy. */
  status: DeploymentStatus
}

export interface StatusResult {
  status: DeploymentStatus
  url: string | null
  error?: string
}

/**
 * Contract every remote-environment deployment provider must implement.
 *
 * All methods are async so network-backed providers fit without wrapping.
 * `teardown` must be idempotent — calling it on an already-torn-down (or
 * unknown) deployment is a silent no-op, never a throw.
 */
export interface DeploymentProvider {
  /** Provision a new preview environment from the given worktree snapshot. */
  deploy(input: DeployInput): Promise<DeployResult>

  /** Poll the readiness state of an existing deployment. */
  status(deploymentId: string): Promise<StatusResult>

  /** Fetch accumulated stdout/stderr from the deployment's build or runtime. */
  logs(deploymentId: string): Promise<string>

  /**
   * Decommission the deployment.  Must be idempotent — a second call for the
   * same (or an unknown) deployment id is a silent no-op.
   */
  teardown(deploymentId: string): Promise<void>
}
