import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import {
  openTraceEventStore,
  type TraceEventStore,
} from '../../lib/trace-events-store'
import type { AgentRosterEntry } from '../live-agents-roster'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-la-rec-')),
  )
})

const makeDeps = (
  store: TraceEventStore,
  overrides: Partial<HttpServerDeps> = {},
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
  recipeCatalog:
    cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: store,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('GET /agents/live', () => {
  let dbDir: string
  let store: TraceEventStore

  beforeEach(async () => {
    dbDir = mkdtempSync(resolve(tmpdir(), 'mars-http-la-'))
    mkdirSync(dbDir, { recursive: true })
    store = await openTraceEventStore(join(dbDir, 'mars.db'))
  })

  afterEach(async () => {
    await store.close()
    rmSync(dbDir, { recursive: true, force: true })
  })

  it('returns empty agents when no getLiveAgentsRoster is provided', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps(store))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/agents/live`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { agents: AgentRosterEntry[] }
      expect(body.agents).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns populated agents from getLiveAgentsRoster', async () => {
    const fakeAgents: AgentRosterEntry[] = [
      {
        id: 'task-1',
        workerName: 'Coder',
        bindingKind: 'task',
        relatedTaskId: 'task-1',
        relatedProposalId: null,
        purpose: 'run-claude-code',
        startedAt: '2026-07-27T10:00:00.000Z',
        lastEventAt: '2026-07-27T10:05:00.000Z',
      },
      {
        id: 'reflector-1722070800000',
        workerName: 'Reflector',
        bindingKind: 'event',
        relatedTaskId: null,
        relatedProposalId: null,
        purpose: 'scheduled',
        startedAt: '2026-07-27T10:00:00.000Z',
        lastEventAt: null,
      },
    ]

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps(store, { getLiveAgentsRoster: () => fakeAgents }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/agents/live`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { agents: AgentRosterEntry[] }
      expect(body.agents).toHaveLength(2)
      expect(body.agents[0]!.workerName).toBe('Coder')
      expect(body.agents[0]!.relatedTaskId).toBe('task-1')
      expect(body.agents[1]!.workerName).toBe('Reflector')
      expect(body.agents[1]!.bindingKind).toBe('event')
    } finally {
      await close()
    }
  })
})
