/**
 * Tests for POST /actions/self-update.
 *
 * The endpoint delegates entirely to deps.selfUpdate(). Tests inject the dep
 * so no real filesystem, network, or binary-swap occurs.
 */
import { describe, expect, it } from 'vitest'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { SelfUpdateError, SELF_UPDATE_ERRORS } from '../self-update'
import type { RecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const nullRecipeCatalog: RecipeCatalog = {
  get: () => null,
  list: () => [],
}

const makeDeps = (
  overrides: Partial<HttpServerDeps> = {},
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
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},

  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: nullRecipeCatalog,
  traceStore: nullTraceStore,
  appServices: stubAppServices({
    viewFrameworkUpdate: async () => ({
      installed: '0.1.0',
      latest: '1.0.0',
      available: true,
      checkedAt: '2026-06-01T00:00:00.000Z',
      releaseUrl: null,
      selfUpdatable: true,
    }),
    ...appServicesOverrides,
  }),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('POST /actions/self-update', () => {
  it('returns 200 { ok: true, status: "started" } when selfUpdate succeeds', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; status: string }
      expect(body.ok).toBe(true)
      expect(body.status).toBe('started')
    } finally {
      await close()
    }
  })

  it('returns 422 when selfUpdate throws DEV_INSTALL', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        selfUpdate: async () => {
          throw new SelfUpdateError(
            SELF_UPDATE_ERRORS.DEV_INSTALL,
            'dev install — use git pull',
          )
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe(SELF_UPDATE_ERRORS.DEV_INSTALL)
    } finally {
      await close()
    }
  })

  it('returns 409 when selfUpdate throws TASKS_IN_FLIGHT', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        selfUpdate: async () => {
          throw new SelfUpdateError(
            SELF_UPDATE_ERRORS.TASKS_IN_FLIGHT,
            '2 tasks are in flight',
          )
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe(SELF_UPDATE_ERRORS.TASKS_IN_FLIGHT)
    } finally {
      await close()
    }
  })

  it('returns 422 when selfUpdate throws SHA256_MISMATCH', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        selfUpdate: async () => {
          throw new SelfUpdateError(
            SELF_UPDATE_ERRORS.SHA256_MISMATCH,
            'digest mismatch',
          )
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      expect(res.status).toBe(422)
    } finally {
      await close()
    }
  })

  it('returns 502 when selfUpdate throws DOWNLOAD_FAILED', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        selfUpdate: async () => {
          throw new SelfUpdateError(
            SELF_UPDATE_ERRORS.DOWNLOAD_FAILED,
            'network error',
          )
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      expect(res.status).toBe(502)
    } finally {
      await close()
    }
  })

  it('returns 500 when selfUpdate throws SWAP_FAILED', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        selfUpdate: async () => {
          throw new SelfUpdateError(
            SELF_UPDATE_ERRORS.SWAP_FAILED,
            'EPERM: operation not permitted',
          )
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe(SELF_UPDATE_ERRORS.SWAP_FAILED)
    } finally {
      await close()
    }
  })

  it('returns 409 when selfUpdate throws NO_UPDATE_AVAILABLE', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        selfUpdate: async () => {
          throw new SelfUpdateError(
            SELF_UPDATE_ERRORS.NO_UPDATE_AVAILABLE,
            'already up to date',
          )
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe(SELF_UPDATE_ERRORS.NO_UPDATE_AVAILABLE)
    } finally {
      await close()
    }
  })

  it('returns 503 when the daemon is draining (isAcceptingWork = false)', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ isAcceptingWork: () => false }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/actions/self-update`, {
        method: 'POST',
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe('DRAINING')
    } finally {
      await close()
    }
  })
})

describe('GET /view/framework-update — selfUpdatable field', () => {
  it('includes selfUpdatable: true when install is prod', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps(
        {},
        {
          viewFrameworkUpdate: async () => ({
            installed: '0.1.0',
            latest: '1.0.0',
            available: true,
            checkedAt: null,
            releaseUrl: null,
            selfUpdatable: true,
          }),
        },
      ),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/framework-update`)
      const body = (await res.json()) as { selfUpdatable: boolean }
      expect(body.selfUpdatable).toBe(true)
    } finally {
      await close()
    }
  })

  it('includes selfUpdatable: false when install is dev', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps(
        {},
        {
          viewFrameworkUpdate: async () => ({
            installed: '0.1.0',
            latest: '1.0.0',
            available: true,
            checkedAt: null,
            releaseUrl: null,
            selfUpdatable: false,
          }),
        },
      ),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/framework-update`)
      const body = (await res.json()) as { selfUpdatable: boolean }
      expect(body.selfUpdatable).toBe(false)
    } finally {
      await close()
    }
  })
})
