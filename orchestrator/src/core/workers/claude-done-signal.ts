// Status-file done-signal helpers for the claude provider.
//
// installClaudeStopHook  — writes a Stop hook into <cwd>/.claude/settings.json
//                          that creates <cwd>/.mars/pty-status/<sessionId>.json
//                          when Claude's turn ends.
//
// waitForClaudeDone      — watches that path and resolves as soon as the file
//                          appears; rejects with AbortError when the signal fires.

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Returns the path where the Stop hook writes its sentinel file. */
function statusFilePath(cwd: string, sessionId: string): string {
  return path.join(cwd, '.mars', 'pty-status', `${sessionId}.json`)
}

/**
 * Writes a Stop hook into <cwd>/.claude/settings.json that creates
 * <cwd>/.mars/pty-status/<sessionId>.json when Claude's turn ends.
 * Merges with any existing settings rather than overwriting them.
 */
export function installClaudeStopHook(cwd: string, sessionId: string): void {
  const statusFile = statusFilePath(cwd, sessionId)

  const settingsDir = path.join(cwd, '.claude')
  fs.mkdirSync(settingsDir, { recursive: true })

  const settingsFile = path.join(settingsDir, 'settings.json')

  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
  } catch {
    // File absent or unparseable — start with empty settings
  }

  const command =
    `MARS_PTY_STATUS_FILE=${statusFile} node -e ` +
    `"require('fs').writeFileSync(process.env.MARS_PTY_STATUS_FILE, JSON.stringify({ts:Date.now()}))"`

  settings.hooks = {
    ...((settings.hooks as Record<string, unknown>) ?? {}),
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command,
          },
        ],
      },
    ],
  }

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8')
}

/**
 * Resolves when <cwd>/.mars/pty-status/<sessionId>.json appears on disk
 * (written by the Stop hook installed by installClaudeStopHook).
 * Rejects with an AbortError when the signal fires.
 */
export function waitForClaudeDone(
  cwd: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const statusFile = statusFilePath(cwd, sessionId)

    if (signal.aborted) {
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
      return
    }

    if (fs.existsSync(statusFile)) {
      resolve()
      return
    }

    const dir = path.dirname(statusFile)
    fs.mkdirSync(dir, { recursive: true })

    const basename = path.basename(statusFile)
    let watcher: fs.FSWatcher | null = null
    let poll: ReturnType<typeof setInterval> | undefined

    // cleanup closes both the watcher and the polling fallback.
    const cleanup = (): void => {
      watcher?.close()
      watcher = null
      if (poll !== undefined) clearInterval(poll)
      poll = undefined
    }

    // seen guards against double-settlement when watcher and poll both fire.
    let seen = false
    const settle = (): void => {
      if (seen) return
      seen = true
      signal.removeEventListener('abort', onAbort)
      cleanup()
      resolve()
    }

    const onAbort = (): void => {
      cleanup()
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
    }

    signal.addEventListener('abort', onAbort, { once: true })

    try {
      watcher = fs.watch(dir, (_eventType, filename) => {
        if ((filename === null || filename === basename) && fs.existsSync(statusFile)) {
          settle()
        }
      })
    } catch (err) {
      signal.removeEventListener('abort', onAbort)
      reject(err)
      return
    }

    // Polling fallback: macOS FSEvents can coalesce events written in the same
    // tick as the watcher setup and never deliver the notification. A 50ms poll
    // catches that race without perceptible latency in production (where Claude
    // takes seconds, not microseconds, to finish).
    poll = setInterval(() => {
      if (fs.existsSync(statusFile)) settle()
    }, 50)
  })
}
