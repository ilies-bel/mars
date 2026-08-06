/**
 * Tests for GET /view/step-prompt — the daemon-side per-step prompt endpoint.
 *
 * Covers:
 *   - 400 when workflowInstanceId is missing
 *   - 400 when stepName is missing
 *   - 200 with the StepPromptView forwarded verbatim from viewStepPrompt
 *   - both query params are decoded and passed through to the use-case
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps, StepPromptView } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import type { TraceEventStore } from '../../lib/trace-events-store'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-step-prompt-cat-'))
  cachedRecipeCatalog = await loadRecipeCatalog(tmpDir)
})

const stubTraceStore: TraceEventStore = {
  record: async () => {},
  query: async () => [],
  close: async () => {},
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
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},

  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<
    ReturnType<typeof loadRecipeCatalog>
  >,
  traceStore: stubTraceStore,
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

describe('GET /view/step-prompt', () => {
  it('returns 400 when workflowInstanceId is missing', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/step-prompt?stepName=run-claude-code`,
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/workflowInstanceId/)
    } finally {
      await close()
    }
  })

  it('returns 400 when stepName is missing', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/step-prompt?workflowInstanceId=wf-1`,
      )
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/stepName/)
    } finally {
      await close()
    }
  })

  it('returns 200 and forwards the StepPromptView verbatim', async () => {
    let received: { workflowInstanceId: string; stepName: string } | null = null
    const view: StepPromptView = {
      workflowInstanceId: 'wf-abc',
      stepName: 'run claude code',
      prompt: 'the exact composed prompt',
      source: 'persisted',
    }

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewStepPrompt: async (params) => {
          received = params
          return view
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/step-prompt?workflowInstanceId=wf-abc&stepName=${encodeURIComponent('run claude code')}`,
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(view)
      expect(received).toEqual({
        workflowInstanceId: 'wf-abc',
        stepName: 'run claude code',
      })
    } finally {
      await close()
    }
  })
})
