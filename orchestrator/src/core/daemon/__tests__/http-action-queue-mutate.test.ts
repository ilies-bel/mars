import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { loadFailureReasonCatalog } from '../../lib/failure-reasons'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-actionQueue-mutate-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const httpServer = (await import(
    '../http-server'
  )) as typeof import('../http-server')
  return { httpServer }
}

let cachedFailureReasonCatalog: Awaited<ReturnType<typeof loadFailureReasonCatalog>> | null = null
let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

const getBuiltInFailureReasonCatalog = async () => {
  if (!cachedFailureReasonCatalog) {
    cachedFailureReasonCatalog = await loadFailureReasonCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-actionQueue-cat-')),
    )
  }
  return cachedFailureReasonCatalog
}

const getBuiltInRecipeCatalog = async () => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-actionQueue-rec-')),
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
  failureReasonCatalog: cachedFailureReasonCatalog as Awaited<ReturnType<typeof loadFailureReasonCatalog>>,
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
  viewSessions: async () => ({ sessions: [] }),
  viewTaskById: async () => null,
  ...overrides,
})

beforeAll(async () => {
  await getBuiltInFailureReasonCatalog()
  await getBuiltInRecipeCatalog()
})

describe('POST /view/action-queue/{ack,resolve,dismiss}', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('POST /view/action-queue/ack dispatches to actionQueueAck with kind and entityId', async () => {
    const { httpServer } = await loadModules(repo)
    const calls: Array<{ kind: string; id: string }> = []

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        actionQueueAck: async (kind, id) => {
          calls.push({ kind, id })
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/action-queue/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'task', entityId: 'mars-abc123' }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(calls).toEqual([{ kind: 'task', id: 'mars-abc123' }])
    } finally {
      await close()
    }
  })

  it('POST /view/action-queue/resolve dispatches to actionQueueResolve with kind and entityId', async () => {
    const { httpServer } = await loadModules(repo)
    const calls: Array<{ kind: string; id: string }> = []

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        actionQueueResolve: async (kind, id) => {
          calls.push({ kind, id })
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/action-queue/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'worktree', entityId: 'wt-id-42' }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(calls).toEqual([{ kind: 'worktree', id: 'wt-id-42' }])
    } finally {
      await close()
    }
  })

  it('POST /view/action-queue/dismiss dispatches to actionQueueDismiss with kind and entityId', async () => {
    const { httpServer } = await loadModules(repo)
    const calls: Array<{ kind: string; id: string }> = []

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        actionQueueDismiss: async (kind, id) => {
          calls.push({ kind, id })
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/action-queue/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'proposal', entityId: 'prop-xyz' }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(calls).toEqual([{ kind: 'proposal', id: 'prop-xyz' }])
    } finally {
      await close()
    }
  })

  it('returns 400 for an unknown kind', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/action-queue/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'unknown-entity', entityId: 'mars-abc' }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toMatch(/kind/)
    } finally {
      await close()
    }
  })

  it('returns 400 when kind is missing', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/action-queue/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId: 'some-id' }),
      })

      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 when entityId is missing', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/action-queue/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'task' }),
      })

      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })
})
