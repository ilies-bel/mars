/**
 * Tests for GET /origins/:taskId — the per-task ancestry tree the actionQueue
 * detail panel renders under "Origins". Pin the multi-slice PRD shape
 * (root proposal, children = sibling slices) and the lone-task fallback.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-or-rec-')),
  )
})

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-origins-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
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
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const queue = (await import('../../queue')) as typeof import('../../queue')
  const proposals = (await import(
    '../../proposals'
  )) as typeof import('../../proposals')
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  await queue.migrateQueueSchema()
  await proposals.initProposals()
  return { queue, proposals, httpServer }
}

interface OriginNodeJson {
  id: string
  kind: string
  title: string
  status: string
  children: OriginNodeJson[]
}

describe('GET /origins/:taskId', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns a single-node tree when the task has no known origin', async () => {
    const { queue, httpServer } = await loadModules(repo)
    const t = await queue.enqueueTask('one-off', undefined, {
      skipTriage: true,
    })

    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/origins/${encodeURIComponent(t.id)}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { node: OriginNodeJson }
      expect(body.node.id).toBe(t.id)
      expect(body.node.kind).toBe('task')
      expect(body.node.children).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns the full tree for a multi-slice PRD, root carries proposal status', async () => {
    const { queue, proposals, httpServer } = await loadModules(repo)
    // Create the proposal, then flip status to `sliced` so it surfaces as
    // a `prd` node (the kind the UI uses to render the badge).
    const prop = await proposals.createProposal('Big feature', {
      problem: 'p',
      solution: 's',
    })
    await proposals.setProposalField(prop.id, 'status', 'sliced')

    const slice1 = await queue.enqueueTask('slice 1', undefined, {
      skipTriage: true,
      parentProposalId: prop.id,
      sliceIndex: 1,
    })
    const slice2 = await queue.enqueueTask('slice 2', undefined, {
      skipTriage: true,
      parentProposalId: prop.id,
      sliceIndex: 2,
    })
    // Mark slice 2 as failed so the right node carries the right status.
    await queue.updateTask(slice2.id, { status: 'failed', error: 'boom' })

    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/origins/${encodeURIComponent(slice2.id)}`,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { node: OriginNodeJson }
      expect(body.node.id).toBe(prop.id)
      expect(body.node.kind).toBe('prd')
      expect(body.node.status).toBe('sliced')
      // Both slices appear as children, ordered by created_at ASC.
      const childIds = body.node.children.map((c) => c.id)
      expect(childIds).toEqual([slice1.id, slice2.id])
      // The right child carries the failed status.
      const failed = body.node.children.find((c) => c.id === slice2.id)
      expect(failed?.status).toBe('failed')
    } finally {
      await close()
    }
  })
})
