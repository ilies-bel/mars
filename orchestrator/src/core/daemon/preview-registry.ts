/**
 * PreviewRegistry — daemon-owned process registry for long-lived stack
 * previews spawned on behalf of task worktrees.
 *
 * Each `preview.spawn` call starts a detached child process whose
 * stdout/stderr are teed to `.mars/previews/<taskId>.log` and returns the
 * PID + log path. The registry survives workflow step-parks (the child stays
 * alive while the step is suspended). `preview.teardown` SIGTERMs the child,
 * waits for exit, and falls back to SIGKILL after a 5-second window.
 *
 * Wired into the RPC layer via `DaemonDeps.handlePreview*`; the three RPC
 * handlers in `rpc/handlers.ts` delegate directly to these methods.
 */

import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { openSync, closeSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

interface PreviewEntry {
  pid: number
  logPath: string
  url?: string
  child: ChildProcess
}

export class PreviewRegistry {
  private readonly entries = new Map<string, PreviewEntry>()

  constructor(private readonly stateDir: string) {}

  async spawn(
    taskId: string,
    cmd: string,
    cwd: string,
  ): Promise<{ pid: number; logPath: string; url?: string }> {
    const previewsDir = resolve(this.stateDir, 'previews')
    mkdirSync(previewsDir, { recursive: true })
    const logPath = resolve(previewsDir, `${taskId}.log`)
    const logFd = openSync(logPath, 'a')

    const child = spawnProcess(cmd, {
      cwd,
      shell: true,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })

    // Close our copy of the fd; the child holds its own inherited copy.
    closeSync(logFd)

    // Detach from the daemon's event loop so the daemon can exit without
    // waiting for preview children to terminate.
    child.unref()

    if (child.pid == null) {
      throw new Error(`preview.spawn: failed to start process for task ${taskId}`)
    }

    const pid = child.pid
    this.entries.set(taskId, { pid, logPath, child })
    return { pid, logPath }
  }

  status(taskId: string): { pid: number; logPath: string; url?: string } | null {
    const entry = this.entries.get(taskId)
    if (!entry) return null
    return { pid: entry.pid, logPath: entry.logPath, url: entry.url }
  }

  async teardown(taskId: string): Promise<void> {
    const entry = this.entries.get(taskId)
    if (!entry) return

    // Remove the entry first so a concurrent teardown call is a no-op.
    this.entries.delete(taskId)

    const { pid, child } = entry

    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Process already gone — nothing to clean up.
      return
    }

    await new Promise<void>((resolvePromise) => {
      let timer: NodeJS.Timeout | undefined

      const done = () => {
        if (timer !== undefined) clearTimeout(timer)
        resolvePromise()
      }

      // Guard against the process already having exited before we registered
      // the listener (exitCode / signalCode are set synchronously on exit).
      if (child.exitCode !== null || child.signalCode !== null) {
        done()
        return
      }

      child.once('exit', done)

      // After 5 s escalate to SIGKILL and resolve without waiting further —
      // SIGKILL delivery is not observable as a Node.js event.
      timer = setTimeout(() => {
        child.removeListener('exit', done)
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // best-effort: process may have exited between the timeout firing
          // and this kill call.
        }
        resolvePromise()
      }, 5_000)
    })
  }
}
