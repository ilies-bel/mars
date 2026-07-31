/**
 * Tests for POST /actions/dismiss/:id — the dismiss entity op that rejects a
 * draft proposal via the daemon HTTP server.
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-dismiss-'))
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
    mkdtempSync(resolve(tmpdir(), 'mars-http-dismiss-rec-')),
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
  restartAllDaemonKilled: async () => [],
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

describe('POST /actions/dismiss/:id', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('calls dismissProposal with the correct id and returns { ok: true }', async () => {
    const { httpServer } = await loadModules(repo)

    const dismissed: string[] = []
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        dismissProposal: async (id) => {
          dismissed.push(id)
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/dismiss/prop-abc123`,
        { method: 'POST' },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(dismissed).toEqual(['prop-abc123'])
    } finally {
      await close()
    }
  })

  it('returns 500 when dismissProposal throws (e.g. proposal has dependent tasks)', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        dismissProposal: async () => {
          throw new Error('cannot be dismissed: has dependent tasks')
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/dismiss/prop-xyz`,
        { method: 'POST' },
      )

      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('dependent tasks')
    } finally {
      await close()
    }
  })

  it('wires dismissProposal through dismissProposal on a real proposal', async () => {
    const { proposals, httpServer } = await loadModules(repo)

    const proposal = await proposals.createProposal('A draft to dismiss', {
      source: 'human',
    })
    expect(proposal.status).toBe('draft')

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        dismissProposal: async (id) => {
          await proposals.dismissProposal(id)
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/dismiss/${proposal.id}`,
        { method: 'POST' },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)

      // Verify the proposal is actually dismissed.
      const updated = await proposals.getProposal(proposal.id)
      expect(updated?.status).toBe('dismissed')
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
