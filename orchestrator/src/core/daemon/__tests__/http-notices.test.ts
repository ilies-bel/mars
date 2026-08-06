import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

let requestHandler: ((req: { method?: string; url?: string }, res: { writeHead: (status: number) => void; end: () => void }) => void) | undefined

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  createServer: (handler: typeof requestHandler) => {
    requestHandler = handler
    return {
      once: () => undefined,
      off: () => undefined,
      on: () => undefined,
      listen: (_port: number, _host: string, done: () => void) => done(),
      address: () => ({ port: 1, address: '127.0.0.1' }),
      close: (done: (error?: Error) => void) => done(),
    }
  },
}))

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-notices-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let recipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>>

beforeAll(async () => {
  recipeCatalog = await loadRecipeCatalog(mkdtempSync(resolve(tmpdir(), 'mars-http-notices-rec-')))
})

const makeDeps = (): HttpServerDeps => ({
  restartTask: async () => {}, remergeTask: async () => {}, unblockTask: async () => {},
  purgeTask: async () => {}, pruneWorktree: async () => {}, dismissProposal: async () => {},
  promoteProposal: async () => {}, validateTask: async () => {}, rejectTask: async () => {},
  landWork: async () => {}, investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }), restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }), isAcceptingWork: () => true, inFlightCount: () => 0,
  selfUpdate: async () => {}, runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {}, stepDone: async () => ({ next: null }), snoozeItem: async () => {},
  recipeCatalog, traceStore: nullTraceStore, appServices: stubAppServices(), chatRunner: stubChatRunner(),
})

describe('retired Notice acknowledgement routes', () => {
  let repo: string

  beforeEach(() => { repo = setupRepo() })
  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('does not expose Notice listing or acknowledgement endpoints', async () => {
    process.env.MARS_REPO = repo
    const { startHttpServer } = await import('../http-server')
    const { close } = await startHttpServer(makeDeps())
    try {
      for (const request of [
        { method: 'GET', url: '/notices' },
        { method: 'POST', url: '/notices/a/ack' },
      ]) {
        let status = 0
        requestHandler!(request, { writeHead: (code) => { status = code }, end: () => {} })
        expect(status).not.toBe(200)
      }
    } finally {
      await close()
    }
  })
})
