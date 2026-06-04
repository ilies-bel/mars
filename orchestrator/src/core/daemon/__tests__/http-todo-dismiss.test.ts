import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-todo-dismiss-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  return { httpServer }
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

const getBuiltInRecipeCatalog = async () => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-todo-dismiss-rec-')),
    )
  }
  return cachedRecipeCatalog
}

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  viewTasks: async () => ({ tasks: [] }),
  viewProgress: async () => ({ tasks: [], proposals: [] }),
  actionQueueAck: async () => {},
  actionQueueResolve: async () => {},
  actionQueueDismiss: async () => {},
  todoDismiss: async () => {},
  viewActionQueue: async () => [],
  viewTodo: async () => ({ drafts: [], staleWorktrees: [] }),
  viewTerminalEvents: async () => ({ events: [] }),
  viewStepSpans: async () => ({ spans: [] }),
  viewSessions: async () => ({ sessions: [] }),
  viewFrameworkUpdate: async () => ({
    installed: '0.1.0',
    latest: '0.1.0',
    available: false,
    checkedAt: null,
    releaseUrl: null,
  }),
  ...overrides,
})

beforeAll(async () => {
  await getBuiltInRecipeCatalog()
})

describe('POST /view/todo/dismiss', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('dispatches to todoDismiss with kind=draft and id', async () => {
    const { httpServer } = await loadModules(repo)
    const calls: Array<{ kind: string; id: string }> = []

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        todoDismiss: async (kind, id) => {
          calls.push({ kind, id })
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/todo/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'draft', id: 'proposal-abc' }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(calls).toEqual([{ kind: 'draft', id: 'proposal-abc' }])
    } finally {
      await close()
    }
  })

  it('dispatches to todoDismiss with kind=stale and id', async () => {
    const { httpServer } = await loadModules(repo)
    const calls: Array<{ kind: string; id: string }> = []

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        todoDismiss: async (kind, id) => {
          calls.push({ kind, id })
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/todo/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'stale', id: 'mars-xyz789' }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(calls).toEqual([{ kind: 'stale', id: 'mars-xyz789' }])
    } finally {
      await close()
    }
  })

  it('returns 400 for an unknown kind', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/todo/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'unknown', id: 'some-id' }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/kind/)
    } finally {
      await close()
    }
  })

  it('returns 400 when id is missing', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/todo/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'draft' }),
      })

      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })
})
