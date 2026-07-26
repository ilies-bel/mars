/**
 * PreviewRegistry integration tests.
 *
 * Exercises the spawn → status → teardown lifecycle through the PreviewRegistry
 * public interface. Uses a real child process (node -e setInterval) so the
 * PID-liveness and log-file assertions run against the actual OS.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PreviewRegistry } from '../preview-registry'

const TASK_ID = 'test-preview-task'

// Use a real temp dir as the stateDir so the test is hermetic.
let stateDir: string

afterEach(() => {
  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

describe('PreviewRegistry', () => {
  it('spawns a process, writes a log file, and teardown removes the PID', async () => {
    stateDir = mkdtempSync(`${tmpdir()}/preview-reg-test-`)
    const registry = new PreviewRegistry(stateDir)

    // Spawn a long-lived node process that never exits on its own.
    const cmd = `${process.execPath} -e "setInterval(()=>{},1e9)"`
    const result = await registry.spawn(TASK_ID, cmd, tmpdir())

    // Log file is created by openSync before spawn returns.
    expect(existsSync(result.logPath)).toBe(true)

    // The spawned process is alive.
    expect(() => process.kill(result.pid, 0)).not.toThrow()

    // status() returns the registry entry.
    const statusBefore = registry.status(TASK_ID)
    expect(statusBefore).not.toBeNull()
    expect(statusBefore!.pid).toBe(result.pid)
    expect(statusBefore!.logPath).toBe(result.logPath)

    // Teardown: SIGTERM the child and wait for exit.
    await registry.teardown(TASK_ID)

    // Registry entry is gone.
    expect(registry.status(TASK_ID)).toBeNull()

    // The process (the shell wrapping node) is no longer alive.
    expect(() => process.kill(result.pid, 0)).toThrow()
  }, 10_000 /* ms; teardown waits up to 5 s before SIGKILL */)

  it('teardown is a no-op for an unknown taskId', async () => {
    stateDir = mkdtempSync(`${tmpdir()}/preview-reg-noop-`)
    const registry = new PreviewRegistry(stateDir)
    // Should resolve without throwing.
    await expect(registry.teardown('nonexistent-task')).resolves.toBeUndefined()
  })

  it('status returns null for an unknown taskId', () => {
    stateDir = mkdtempSync(`${tmpdir()}/preview-reg-status-`)
    const registry = new PreviewRegistry(stateDir)
    expect(registry.status('nonexistent-task')).toBeNull()
  })
})
