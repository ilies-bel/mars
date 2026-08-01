/**
 * Tests for GET /view/framework-update.
 *
 * The route is a pure read: it delegates to deps.viewFrameworkUpdate() and
 * returns the result as JSON. Tests inject the dep so no real filesystem or
 * network access occurs.
 */
import { describe, expect, it } from 'vitest'
import type { FrameworkUpdateState, HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import type { RecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const nullRecipeCatalog: RecipeCatalog = {
  get: () => null,
  list: () => [],
}

const makeDeps = (
  appServicesOverrides: Partial<AppServices> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => {},
  validateTask: async () => {},
  rejectTask: async () => {},
  landWork: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},

  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: nullRecipeCatalog,
  traceStore: nullTraceStore,
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

describe('GET /view/framework-update', () => {
  it('returns 200 with the fallback shape when no cache exists', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/framework-update`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as FrameworkUpdateState
      expect(body.installed).toBe('0.1.0')
      expect(body.latest).toBe('0.1.0')
      expect(body.available).toBe(false)
      expect(body.checkedAt).toBeNull()
      expect(body.releaseUrl).toBeNull()
    } finally {
      await close()
    }
  })

  it('returns the cache payload when an update is available', async () => {
    const cached: FrameworkUpdateState = {
      installed: '0.1.0',
      latest: '1.0.0',
      available: true,
      checkedAt: '2026-05-30T12:00:00.000Z',
      releaseUrl: 'https://github.com/ilies-bel/mars/releases/tag/v1.0.0',
    selfUpdatable: false,
    }
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewFrameworkUpdate: async () => cached }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/framework-update`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as FrameworkUpdateState
      expect(body).toEqual(cached)
    } finally {
      await close()
    }
  })

  it('returns a dev checkout cache without an update banner', async () => {
    const cached: FrameworkUpdateState = {
      installed: '0.15.0-48-gabc1234',
      latest: '0.15.0',
      available: false,
      checkedAt: '2026-05-30T12:00:00.000Z',
      releaseUrl: 'https://github.com/ilies-bel/mars/releases/tag/v0.15.0',
      selfUpdatable: false,
    }
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewFrameworkUpdate: async () => cached }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/framework-update`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(cached)
    } finally {
      await close()
    }
  })

  it('surfaces errors from viewFrameworkUpdate as 500', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewFrameworkUpdate: async () => {
          throw new Error('io error')
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/framework-update`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('io error')
    } finally {
      await close()
    }
  })
})
