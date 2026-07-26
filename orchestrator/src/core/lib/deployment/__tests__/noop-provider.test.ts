/**
 * Unit tests for NoopProvider — the deterministic in-memory deployment
 * provider used in local development and test contexts.
 *
 * All tests operate through the DeploymentProvider interface so they remain
 * insensitive to internal implementation details.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { NoopProvider } from '../noop-provider'
import type { DeploymentProvider } from '../provider'

describe('NoopProvider', () => {
  let provider: DeploymentProvider

  beforeEach(() => {
    provider = new NoopProvider()
  })

  describe('deploy', () => {
    it('returns pending status with the noop URL immediately', async () => {
      const result = await provider.deploy({
        taskId: 'task-abc',
        worktreePath: '/tmp/worktree/task-abc',
        branch: 'task/task-abc',
        env: {},
      })

      expect(result.deploymentId).toBe('noop-task-abc')
      expect(result.url).toBe('https://noop.local/task-abc')
      expect(result.status).toBe('pending')
    })

    it('incorporates the taskId into both the deploymentId and the URL', async () => {
      const result = await provider.deploy({
        taskId: 'my-task-123',
        worktreePath: '/tmp/my-task-123',
        branch: 'task/my-task-123',
        env: { FEATURE_FLAG: 'true' },
      })

      expect(result.deploymentId).toContain('my-task-123')
      expect(result.url).toContain('my-task-123')
    })
  })

  describe('status', () => {
    it('transitions pending → ready on the first call', async () => {
      const { deploymentId } = await provider.deploy({
        taskId: 'task-flip',
        worktreePath: '/tmp/task-flip',
        branch: 'task/task-flip',
        env: {},
      })

      const first = await provider.status(deploymentId)
      expect(first.status).toBe('ready')
      expect(first.url).toBe('https://noop.local/task-flip')
    })

    it('stays ready on subsequent status calls after first flip', async () => {
      const { deploymentId } = await provider.deploy({
        taskId: 'task-stable',
        worktreePath: '/tmp/task-stable',
        branch: 'task/task-stable',
        env: {},
      })

      await provider.status(deploymentId)
      const second = await provider.status(deploymentId)
      expect(second.status).toBe('ready')
    })

    it('returns failed status with error message for an unknown deploymentId', async () => {
      const result = await provider.status('does-not-exist')
      expect(result.status).toBe('failed')
      expect(result.url).toBeNull()
      expect(result.error).toBeDefined()
    })
  })

  describe('logs', () => {
    it('returns a non-empty string for a known deployment', async () => {
      const { deploymentId } = await provider.deploy({
        taskId: 'task-logs',
        worktreePath: '/tmp/task-logs',
        branch: 'task/task-logs',
        env: {},
      })

      const logs = await provider.logs(deploymentId)
      expect(typeof logs).toBe('string')
      expect(logs.length).toBeGreaterThan(0)
    })

    it('returns a string (not a throw) for an unknown deployment', async () => {
      const logs = await provider.logs('nonexistent-id')
      expect(typeof logs).toBe('string')
    })
  })

  describe('teardown', () => {
    it('tears down a known deployment without throwing', async () => {
      const { deploymentId } = await provider.deploy({
        taskId: 'task-down',
        worktreePath: '/tmp/task-down',
        branch: 'task/task-down',
        env: {},
      })

      await expect(provider.teardown(deploymentId)).resolves.toBeUndefined()
    })

    it('is idempotent — second teardown call is a silent no-op', async () => {
      const { deploymentId } = await provider.deploy({
        taskId: 'task-idempotent',
        worktreePath: '/tmp/task-idempotent',
        branch: 'task/task-idempotent',
        env: {},
      })

      await provider.teardown(deploymentId)
      // Second call must not throw.
      await expect(provider.teardown(deploymentId)).resolves.toBeUndefined()
    })

    it('is a no-op for a deployment id that was never created', async () => {
      await expect(provider.teardown('never-existed')).resolves.toBeUndefined()
    })

    it('status after teardown returns failed (unknown deployment)', async () => {
      const { deploymentId } = await provider.deploy({
        taskId: 'task-after-down',
        worktreePath: '/tmp/task-after-down',
        branch: 'task/task-after-down',
        env: {},
      })

      await provider.teardown(deploymentId)
      const result = await provider.status(deploymentId)
      expect(result.status).toBe('failed')
    })
  })
})
