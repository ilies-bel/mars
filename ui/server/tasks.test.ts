/**
 * Tests for GET /api/tasks via the UI server proxy.
 *
 * After the daemon-as-sole-reader migration (PRD 3a1350a3 slice 1), the
 * /api/tasks endpoint no longer opens any database itself — it proxies
 * GET /view/tasks on the daemon and relays the response verbatim.
 *
 * These tests spin up a real daemon HTTP server (using startHttpServer)
 * to serve /view/tasks, write the port to the .mars/http.port file, and
 * then confirm the UI server proxies the response correctly.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startHttpServer } from '../../orchestrator/src/core/daemon/http-server.ts'
import type { HttpServerDeps } from '../../orchestrator/src/core/daemon/http-server.ts'
import { stubAppServices } from '../../orchestrator/src/core/daemon/__tests__/app-services-stub.ts'
import { loadRecipeCatalog } from '../../orchestrator/src/core/lib/recipes.ts'
import { nullTraceStore } from '../../orchestrator/src/core/lib/run-tool.ts'
import { startServer } from './index.ts'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-ui-tasks-rc-')),
  )
})

const makeDaemonDeps = (
  viewTasks: HttpServerDeps['appServices']['viewTasks'],
): HttpServerDeps => ({
  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  validateTask: async () => {},
  rejectTask: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  recipeCatalog:
    cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices({ viewTasks }),
})

describe('GET /api/tasks — proxies daemon /view/tasks', () => {
  let repo: string
  let uiServer: ReturnType<typeof Bun.serve> | null = null

  beforeEach(async () => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-ui-tasks-test-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.mars'), { recursive: true })
  })

  afterEach(() => {
    if (uiServer) {
      uiServer.stop(true)
      uiServer = null
    }
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the task list from the daemon when the daemon is running', async () => {
    const fakeTasks = [
      { id: 'mars-aaa', prompt: 'task one', status: 'queued' },
      { id: 'mars-bbb', prompt: 'task two', status: 'running' },
    ]

    const daemonHandle = await startHttpServer(
      makeDaemonDeps(async () => ({ tasks: fakeTasks })),
    )

    try {
      // Point the UI server at this fake daemon by writing the port file.
      writeFileSync(join(repo, '.mars', 'http.port'), String(daemonHandle.port))

      uiServer = await startServer({ repo, port: 0, host: '127.0.0.1' })
      const baseUrl = `http://${uiServer.hostname}:${uiServer.port}`

      const res = await fetch(`${baseUrl}/api/tasks`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { tasks: Array<{ id: string; status: string }> }
      expect(body.tasks).toHaveLength(2)
      const ids = body.tasks.map((t) => t.id)
      expect(ids).toContain('mars-aaa')
      expect(ids).toContain('mars-bbb')
    } finally {
      await daemonHandle.close()
    }
  })

  it('returns 503 when the daemon is not running', async () => {
    // No daemon started, no http.port file written.
    uiServer = await startServer({ repo, port: 0, host: '127.0.0.1' })
    const baseUrl = `http://${uiServer.hostname}:${uiServer.port}`

    const res = await fetch(`${baseUrl}/api/tasks`)
    expect(res.status).toBe(503)
  })
})
