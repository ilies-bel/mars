/**
 * Integration tests for the four proposal-mutation endpoints added in slice 4:
 *
 *   POST /actions/proposal.set-field/:id   { field, value }  → { ok: true }
 *   POST /actions/proposal.add-story/:id   { story }         → { ok: true, id }
 *   POST /actions/proposal.remove-story/:id { index }        → { ok: true }
 *   POST /actions/proposal.delete/:id      (no body)         → { ok: true }
 *
 * Tests drive a real `startHttpServer` instance with stub deps so they exercise
 * the full route-wiring, body parsing, and error-response contracts without
 * touching a live daemon or a live PostgreSQL database.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-proposal-mut-'))
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
    mkdtempSync(resolve(tmpdir(), 'mars-http-proposal-mut-rec-')),
  )
})

const makeDeps = (
  overrides: Partial<HttpServerDeps> = {},
): HttpServerDeps => ({
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
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

// ---------------------------------------------------------------------------
// POST /actions/proposal.set-field/:id
// ---------------------------------------------------------------------------

describe('POST /actions/proposal.set-field/:id', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('calls setProposalField with id, field, and value — returns { ok: true }', async () => {
    const { httpServer } = await loadModules(repo)
    const calls: Array<{ id: string; field: string; value: string }> = []
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        setProposalField: async (id, field, value) => {
          calls.push({ id, field, value })
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.set-field/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'title', value: 'New title' }),
        },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({ id: 'prop-abc', field: 'title', value: 'New title' })
    } finally {
      await close()
    }
  })

  it('returns 422 for an unknown field name', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ setProposalField: async () => {} }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.set-field/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'nonexistent-field', value: 'x' }),
        },
      )
      expect(res.status).toBe(422)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('nonexistent-field')
    } finally {
      await close()
    }
  })

  it('returns 400 when field is missing from body', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ setProposalField: async () => {} }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.set-field/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'something' }),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 when value is missing from body', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ setProposalField: async () => {} }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.set-field/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'title' }),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 501 when dep is not provided', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.set-field/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'title', value: 'x' }),
        },
      )
      expect(res.status).toBe(501)
    } finally {
      await close()
    }
  })

  it('wires to real setProposalField and mutates the proposal', async () => {
    const { proposals, httpServer } = await loadModules(repo)
    const proposal = await proposals.createProposal('Original title', { source: 'human' })
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        setProposalField: async (id, field, value) => {
          await proposals.setProposalField(id, field as import('../../proposals').ProposalField, value)
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.set-field/${proposal.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'problem', value: 'Users cannot do X' }),
        },
      )
      expect(res.status).toBe(200)
      const updated = await proposals.getProposal(proposal.id)
      expect(updated?.problem).toBe('Users cannot do X')
    } finally {
      await close()
    }
  })

  it('returns 404 when the proposal does not exist', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        setProposalField: async () => {
          throw new Error('proposal nonexistent not found')
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.set-field/nonexistent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: 'title', value: 'x' }),
        },
      )
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// POST /actions/proposal.add-story/:id
// ---------------------------------------------------------------------------

describe('POST /actions/proposal.add-story/:id', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('calls addProposalUserStory with id and story — returns { ok: true, id }', async () => {
    const { httpServer } = await loadModules(repo)
    const calls: Array<{ id: string; story: string }> = []
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        addProposalUserStory: async (id, story) => {
          calls.push({ id, story })
          return { id: '0' }
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.add-story/prop-xyz`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ story: 'As a user I can do X' }),
        },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; id: string }
      expect(body.ok).toBe(true)
      expect(typeof body.id).toBe('string')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({ id: 'prop-xyz', story: 'As a user I can do X' })
    } finally {
      await close()
    }
  })

  it('returns 400 when story is missing', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ addProposalUserStory: async () => ({ id: '0' }) }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.add-story/prop-xyz`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 when story is an empty string', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ addProposalUserStory: async () => ({ id: '0' }) }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.add-story/prop-xyz`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ story: '' }),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 501 when dep is not provided', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.add-story/prop-xyz`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ story: 'A story' }),
        },
      )
      expect(res.status).toBe(501)
    } finally {
      await close()
    }
  })

  it('wires to real addProposalUserStory and appends the story', async () => {
    const { proposals, httpServer } = await loadModules(repo)
    const proposal = await proposals.createProposal('A proposal', { source: 'human' })
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        addProposalUserStory: async (id, story) => {
          const updated = await proposals.addProposalUserStory(id, story)
          return { id: String(updated.userStories.length - 1) }
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.add-story/${proposal.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ story: 'As a user I can do X' }),
        },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; id: string }
      expect(body.ok).toBe(true)
      expect(body.id).toBe('0')
      const updated = await proposals.getProposal(proposal.id)
      expect(updated?.userStories).toEqual(['As a user I can do X'])
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// POST /actions/proposal.remove-story/:id
// ---------------------------------------------------------------------------

describe('POST /actions/proposal.remove-story/:id', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('calls removeProposalUserStory with id and index — returns { ok: true }', async () => {
    const { httpServer } = await loadModules(repo)
    const calls: Array<{ id: string; index: number }> = []
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        removeProposalUserStory: async (id, index) => {
          calls.push({ id, index })
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.remove-story/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: 1 }),
        },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({ id: 'prop-abc', index: 1 })
    } finally {
      await close()
    }
  })

  it('returns 400 when index is missing', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ removeProposalUserStory: async () => {} }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.remove-story/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 when index is negative', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ removeProposalUserStory: async () => {} }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.remove-story/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: -1 }),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 when index is not an integer', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ removeProposalUserStory: async () => {} }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.remove-story/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: 1.5 }),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 501 when dep is not provided', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.remove-story/prop-abc`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: 0 }),
        },
      )
      expect(res.status).toBe(501)
    } finally {
      await close()
    }
  })

  it('wires to real removeProposalUserStory and removes the story', async () => {
    const { proposals, httpServer } = await loadModules(repo)
    const proposal = await proposals.createProposal('A proposal', { source: 'human' })
    await proposals.addProposalUserStory(proposal.id, 'Story A')
    await proposals.addProposalUserStory(proposal.id, 'Story B')
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        removeProposalUserStory: async (id, index) => {
          await proposals.removeProposalUserStory(id, index)
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.remove-story/${proposal.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: 0 }),
        },
      )
      expect(res.status).toBe(200)
      const updated = await proposals.getProposal(proposal.id)
      expect(updated?.userStories).toEqual(['Story B'])
    } finally {
      await close()
    }
  })
})

// ---------------------------------------------------------------------------
// POST /actions/proposal.delete/:id
// ---------------------------------------------------------------------------

describe('POST /actions/proposal.delete/:id', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('calls deleteProposal with the correct id — returns { ok: true }', async () => {
    const { httpServer } = await loadModules(repo)
    const deleted: string[] = []
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        deleteProposal: async (id) => { deleted.push(id) },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.delete/prop-del-123`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(deleted).toEqual(['prop-del-123'])
    } finally {
      await close()
    }
  })

  it('returns 501 when dep is not provided', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.delete/prop-abc`,
        { method: 'POST' },
      )
      expect(res.status).toBe(501)
    } finally {
      await close()
    }
  })

  it('returns 404 when the proposal does not exist', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        deleteProposal: async (id) => {
          throw new Error(`proposal ${id} not found`)
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.delete/ghost`,
        { method: 'POST' },
      )
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('wires to real deleteProposal and removes the proposal', async () => {
    const { proposals, httpServer } = await loadModules(repo)
    const proposal = await proposals.createProposal('To be deleted', { source: 'human' })
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        deleteProposal: async (id) => {
          await proposals.deleteProposal(id)
        },
      }),
    )
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/proposal.delete/${proposal.id}`,
        { method: 'POST' },
      )
      expect(res.status).toBe(200)
      const updated = await proposals.getProposal(proposal.id)
      expect(updated).toBeNull()
    } finally {
      await close()
    }
  })
})
