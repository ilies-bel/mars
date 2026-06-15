/**
 * Tests for the preview dev-server primitives: free-port allocation, detached
 * spawn (with PORT injected + output captured to a log file), liveness probe,
 * and idempotent process-group kill.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  allocatePort,
  startDevServer,
  isDevServerAlive,
  killDevServer,
} from '../dev-server'

const dirs: string[] = []
const mkDir = (): string => {
  const d = mkdtempSync(resolve(tmpdir(), 'mars-devserver-test-'))
  dirs.push(d)
  return d
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('allocatePort', () => {
  it('returns a usable port in range and two calls differ most of the time', async () => {
    const p = await allocatePort()
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(65536)
  })
})

describe('startDevServer / killDevServer', () => {
  it('spawns a long-running process, injects PORT, writes a log, and is killable', async () => {
    const cwd = mkDir()
    const logDir = resolve(cwd, 'logs')
    // A tiny long-lived server that echoes its PORT then sleeps. `node -e` is
    // portable and avoids depending on any project dev script.
    const handle = await startDevServer({
      command: `node -e "console.log('listening on ' + process.env.PORT); setInterval(()=>{}, 1000)"`,
      cwd,
      taskId: 'task-abc',
      logDir,
    })

    expect(handle.pid).toBeGreaterThan(0)
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`)
    expect(handle.logPath).toBe(resolve(logDir, 'task-abc.log'))

    // Give the child a moment to boot and flush its first line.
    await sleep(400)
    expect(isDevServerAlive(handle.pid)).toBe(true)
    expect(existsSync(handle.logPath)).toBe(true)
    const log = readFileSync(handle.logPath, 'utf8')
    expect(log).toContain(`listening on ${handle.port}`)

    await killDevServer(handle.pid)
    // killDevServer resolves after the SIGKILL grace window; the process group
    // is gone by now.
    expect(isDevServerAlive(handle.pid)).toBe(false)
  })

  it('killDevServer is a no-op for null / already-dead pids', async () => {
    await expect(killDevServer(null)).resolves.toBeUndefined()
    await expect(killDevServer(0)).resolves.toBeUndefined()
    // A pid that is essentially never alive.
    await expect(killDevServer(2_147_483_646)).resolves.toBeUndefined()
  })
})

describe('isDevServerAlive', () => {
  it('returns false for invalid pids', () => {
    expect(isDevServerAlive(0)).toBe(false)
    expect(isDevServerAlive(-1)).toBe(false)
    expect(isDevServerAlive(Number.NaN)).toBe(false)
  })

  it('returns true for the current process', () => {
    expect(isDevServerAlive(process.pid)).toBe(true)
  })
})
