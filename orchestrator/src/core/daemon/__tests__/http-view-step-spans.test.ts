/**
 * Tests for GET /view/step-spans — the daemon-side step-span endpoint.
 *
 * Covers:
 *   - 400 when originId is missing
 *   - 200 with spans forwarded verbatim from viewStepSpans
 *   - viewStepSpans is called with the correct originId
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps, StepSpan } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import type { TraceEventStore } from '../../lib/trace-events-store'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-step-spans-cat-'))
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

// ── GET /view/step-spans ──────────────────────────────────────────────────────

describe('GET /view/step-spans', () => {
  it('returns 400 when originId query param is missing', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/step-spans`)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/originId/)
    } finally {
      await close()
    }
  })

  it('returns 200 and calls viewStepSpans with the given originId', async () => {
    let receivedOriginId: string | null = null

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewStepSpans: async ({ originId }) => {
          receivedOriginId = originId ?? null
          return { spans: [] }
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/step-spans?originId=origin-abc`,
      )
      expect(res.status).toBe(200)
      expect(receivedOriginId).toBe('origin-abc')
    } finally {
      await close()
    }
  })

  it('returns spans from viewStepSpans verbatim', async () => {
    const mockSpans: StepSpan[] = [
      {
        stepName: 'setup',
        phase: 'setup',
        workflowInstanceId: 'wf-1',
        workerName: 'coder',
        outcome: 'completed',
        startedAt: '2024-01-01T00:00:00.000Z',
        endedAt: '2024-01-01T00:01:00.000Z',
        durationMs: 60000,
        taskId: 'task-1',
        originId: 'origin-abc',
      },
      {
        stepName: 'code',
        phase: 'code',
        workflowInstanceId: 'wf-1',
        workerName: 'coder',
        outcome: 'running',
        startedAt: '2024-01-01T00:01:00.000Z',
        endedAt: null,
        durationMs: null,
        taskId: 'task-1',
        originId: 'origin-abc',
      },
    ]

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewStepSpans: async () => ({ spans: mockSpans }),
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/view/step-spans?originId=origin-abc`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { spans: StepSpan[] }
      expect(body.spans).toHaveLength(2)
      expect(body.spans[0]!.stepName).toBe('setup')
      expect(body.spans[0]!.outcome).toBe('completed')
      expect(body.spans[1]!.stepName).toBe('code')
      expect(body.spans[1]!.outcome).toBe('running')
      expect(body.spans[1]!.endedAt).toBeNull()
    } finally {
      await close()
    }
  })
})
