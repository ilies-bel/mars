/**
 * Integration test: GET /view/action-queue with a real createConditionItemsSource.
 *
 * The existing http-view-action-queue.test.ts stubs appServices.viewActionQueue
 * entirely, so the derived-conditions path (ADR-0057) is never exercised through
 * the HTTP layer. This gap is exactly why the bare-require outage (mars-4e470f60)
 * shipped past a green verify: no test drove a real conditionsSource through the
 * HTTP handler.
 *
 * These tests wire the REAL createConditionItemsSource into buildActionQueueView
 * inside a real startHttpServer, assert HTTP 200, and check that the response is
 * a well-formed JSON array. This test would have 500'd against the pre-fix code
 * (require() threw inside getConditionsSource, crashing the viewActionQueue call).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { createConditionItemsSource } from '../view/derived-conditions.js'
import { stubAppServices, stubChatRunner } from './app-services-stub.js'
import type { DbClient } from '../../lib/db.js'
import type { ActionQueueRow } from '../view/action-queue.js'
import { loadRecipeCatalog } from '../../lib/recipes.js'
import { nullTraceStore } from '../../lib/run-tool.js'

// ── Mock DB client (no DB needed for daemon-died derivation) ──────────────────
const emptyDbClient: DbClient = {
  execute: async () => ({ rows: [], rowsAffected: 0 }),
  batch: async () => [],
  close: async () => {},
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /view/action-queue with real conditionsSource (integration)', () => {
  let httpServer: { port: number; close: () => Promise<void> } | null = null
  let tmpDir: string
  let recipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>>

  beforeAll(async () => {
    const catDir = mkdtempSync(resolvePath(tmpdir(), 'mars-cond-integ-cat-'))
    recipeCatalog = await loadRecipeCatalog(catDir)
  })

  beforeEach(async () => {
    tmpDir = mkdtempSync(resolvePath(tmpdir(), 'mars-cond-integ-'))

    const { startHttpServer } = await import('../http-server.js')
    const { buildActionQueueView } = await import('../view/action-queue.js')

    // Build a real conditionsSource wired to an empty-DB mock.
    const conditionsSource = createConditionItemsSource({
      getClient: () => emptyDbClient,
    })

    httpServer = await startHttpServer({
      restartTask: async () => {},
      continueTask: async () => {},
      remergeTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      dismissProposal: async () => {},
      promoteProposal: async () => ({ taskIds: [] }),
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
      disableAutoReflect: async () => {},
      stepDone: async () => ({ next: null as string | null }),
      snoozeItem: async () => {},
      recipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices({
        // Override viewActionQueue to route through the real conditionsSource —
        // this is the code path that was broken by bare require() in server.ts.
        viewActionQueue: async (filter) => {
          return buildActionQueueView({
            stateStore: {
              listOpenActionQueueItems: async () => [],
              listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
            },
            taskStore: { listTasksForActionQueueItems: async () => [] },
            repoRoot: tmpDir,
            filter,
            conditionsSource,
          })
        },
      }),
      chatRunner: stubChatRunner(),
    })
  })

  afterEach(async () => {
    await httpServer?.close()
    httpServer = null
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns HTTP 200 and a JSON array for GET /view/action-queue?filter=open', async () => {
    const url = `http://127.0.0.1:${httpServer!.port}/view/action-queue?filter=open`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as unknown
    expect(Array.isArray(body)).toBe(true)
  })

  it('returns an empty array when no conditions hold and no stored rows exist', async () => {
    const url = `http://127.0.0.1:${httpServer!.port}/view/action-queue?filter=open`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActionQueueRow[]
    // With an empty DB and no crash marker, no derived rows should appear.
    expect(body).toEqual([])
  })

  it('returns a daemon-died row when a crash marker file is present', async () => {
    const { startHttpServer } = await import('../http-server.js')
    const { buildActionQueueView } = await import('../view/action-queue.js')

    // Write a crash marker so the derivation returns a row.
    const markerPath = resolvePath(tmpDir, 'daemon.crash.json')
    writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 54321,
        startedAt: '2026-08-10T08:00:00.000Z',
        crashDetectedAt: '2026-08-10T08:30:00.000Z',
      }),
    )

    const condSourceWithMarker = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: markerPath,
    })

    // Create a separate server for this test.
    let server2: { port: number; close: () => Promise<void> } | null = null
    try {
      server2 = await startHttpServer({
        restartTask: async () => {},
      continueTask: async () => {},
        remergeTask: async () => {},
        unblockTask: async () => {},
        purgeTask: async () => {},
        pruneWorktree: async () => {},
        dismissProposal: async () => {},
        promoteProposal: async () => ({ taskIds: [] }),
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
        disableAutoReflect: async () => {},
        stepDone: async () => ({ next: null as string | null }),
        snoozeItem: async () => {},
        recipeCatalog,
        traceStore: nullTraceStore,
        appServices: stubAppServices({
          viewActionQueue: async (filter) => {
            return buildActionQueueView({
              stateStore: {
                listOpenActionQueueItems: async () => [],
                listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
              },
              taskStore: { listTasksForActionQueueItems: async () => [] },
              repoRoot: tmpDir,
              filter,
              conditionsSource: condSourceWithMarker,
            })
          },
        }),
        chatRunner: stubChatRunner(),
      })

      const url = `http://127.0.0.1:${server2.port}/view/action-queue?filter=open`
      const res = await fetch(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ActionQueueRow[]
      expect(Array.isArray(body)).toBe(true)
      const daemonDiedRow = body.find((r) => r.kind === 'daemon-died')
      expect(daemonDiedRow).toBeDefined()
      // The view renderer formats the title with pid — just assert the kind is correct.
      expect(daemonDiedRow!.kind).toBe('daemon-died')
    } finally {
      await server2?.close()
    }
  })
})
