/**
 * Tests for POST /actions/promote/:id — the promote entity op that promotes a
 * draft proposal to prd-ready via the daemon HTTP server.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-promote-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const proposals = (await import(
    '../../proposals'
  )) as typeof import('../../proposals')
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  await proposals.initProposals()
  return { proposals, httpServer }
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-promote-rec-')),
  )
})

const makeDeps = (
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
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('POST /actions/promote/:id', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('calls promoteProposal with the correct id and returns { ok: true }', async () => {
    const { httpServer } = await loadModules(repo)

    const promoted: string[] = []
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        promoteProposal: async (id) => {
          promoted.push(id)
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/promote/prop-abc123`,
        { method: 'POST' },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(promoted).toEqual(['prop-abc123'])
    } finally {
      await close()
    }
  })

  it('returns 500 when promoteProposal throws (e.g. proposal not fully shaped)', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        promoteProposal: async () => {
          throw new Error('proposal is not fully shaped; missing: problem, solution')
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/promote/prop-xyz`,
        { method: 'POST' },
      )

      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('not fully shaped')
    } finally {
      await close()
    }
  })

  it('wires promoteProposal through real promoteProposal on a fully-shaped proposal', async () => {
    const { proposals, httpServer } = await loadModules(repo)

    // Create a fully-shaped proposal (title, problem, solution, >=1 user story).
    const proposal = await proposals.createProposal('A draft to promote', {
      source: 'human',
      problem: 'Users cannot do X',
      solution: 'Implement Y to enable X',
    })
    await proposals.addProposalUserStory(proposal.id, 'As a user I can do X')
    expect(proposal.status).toBe('draft')

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        promoteProposal: async (id) => {
          await proposals.promoteProposal(id)
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/promote/${proposal.id}`,
        { method: 'POST' },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)

      // Verify the proposal is actually promoted to prd-ready.
      const updated = await proposals.getProposal(proposal.id)
      expect(updated?.status).toBe('prd-ready')
    } finally {
      await close()
    }
  })

  it('returns 404 for unknown action op (copy must never reach the daemon)', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/copy/some-id`,
        { method: 'POST' },
      )
      // 'copy' is client-side only; the daemon returns 404 for it.
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })
})
