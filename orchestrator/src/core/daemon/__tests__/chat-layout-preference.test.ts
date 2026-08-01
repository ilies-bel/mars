/** Behavioural coverage for the persisted chat layout preference route. */
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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-chat-layout-route-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const stateStore = await import('../../store/state-store')
  const httpServer = await import('../http-server')
  await stateStore.migrateStateSchema()
  return { httpServer }
}

let recipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>>

beforeAll(async () => {
  recipeCatalog = await loadRecipeCatalog(mkdtempSync(resolve(tmpdir(), 'mars-chat-layout-rec-')))
})

const makeDeps = (): HttpServerDeps => ({
  restartTask: async () => {}, remergeTask: async () => {}, unblockTask: async () => {},
  purgeTask: async () => {}, pruneWorktree: async () => {}, dismissProposal: async () => {},
  promoteProposal: async () => {}, validateTask: async () => {}, rejectTask: async () => {},
  landWork: async () => {}, investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }), restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [], isAcceptingWork: () => true, inFlightCount: () => 0,
  selfUpdate: async () => {}, runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {}, stepDone: async () => ({ next: null }), snoozeItem: async () => {},
  recipeCatalog, traceStore: nullTraceStore, appServices: stubAppServices(), chatRunner: stubChatRunner(),
})

describe('chat layout preference', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('defaults to focus and persists a threads selection for subsequent clients', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const base = `http://127.0.0.1:${port}/preferences/chat-layout`
      expect(await (await fetch(base)).json()).toEqual({ layout: 'focus' })

      const put = await fetch(base, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: 'threads' }),
      })
      expect(put.status).toBe(200)
      expect(await put.json()).toEqual({ layout: 'threads' })
      expect(await (await fetch(base)).json()).toEqual({ layout: 'threads' })
    } finally { await close() }
  })

  it('rejects layouts other than focus or threads', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())
    try {
      const response = await fetch(`http://127.0.0.1:${port}/preferences/chat-layout`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: 'split' }),
      })
      expect(response.status).toBe(400)
    } finally { await close() }
  })
})
