/**
 * Tests for GET /healthz — the UI liveness probe.
 *
 * The route must return 200 { ok: true } regardless of whether the daemon
 * is draining, so the UI correctly reports a live-but-draining daemon as
 * 'live' rather than 'down'.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-healthz-rec-')),
  )
})

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  viewTasks: async () => ({ tasks: [] }),
  viewProgress: async () => ({ tasks: [], proposals: [] }),
  actionQueueAck: async () => {},
  actionQueueResolve: async () => {},
  actionQueueDismiss: async () => {},
  todoDismiss: async () => {},
  viewActionQueue: async () => [],
  viewTodo: async () => ({ drafts: [], staleWorktrees: [] }),
  viewTerminalEvents: async () => ({ events: [] }),
  viewStepSpans: async () => ({ spans: [] }),
  viewSessions: async () => ({ sessions: [] }),
  viewFrameworkUpdate: async () => ({
    installed: '0.1.0',
    latest: '0.1.0',
    available: false,
    checkedAt: null,
    releaseUrl: null,
    selfUpdatable: false,
  }),
  ...overrides,
})

describe('GET /healthz', () => {
  it('returns 200 { ok: true } when the daemon is accepting work', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = await res.json()
      expect(body).toEqual({ ok: true })
    } finally {
      await close()
    }
  })

  it('returns 200 { ok: true } even when the daemon is draining (isAcceptingWork = false)', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({ isAcceptingWork: () => false }))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ ok: true })
    } finally {
      await close()
    }
  })
})
