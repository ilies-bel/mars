/**
 * Tests for POST /tasks/:id/question — the daemon-owned outbox-publish route
 * that backs `mars task ask` (modular-core: "move the CLI's outbox publish
 * behind a daemon API"). The route delegates entirely to
 * `deps.raiseTaskQuestion()`; these tests inject the dep so no real database
 * write occurs.
 *
 * The second `describe` below drives the CLI-side `raiseTaskQuestion` client
 * (`core/daemon/client`) against a REAL `startHttpServer` instance over a real
 * TCP socket — the actual cross-process boundary `mars task ask` now crosses
 * — rather than mocking `fetch`.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import type { RecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const nullRecipeCatalog: RecipeCatalog = {
  get: () => null,
  list: () => [],
}

const makeDeps = (
  overrides: Partial<HttpServerDeps> = {},
  appServicesOverrides: Partial<AppServices> = {},
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
  recipeCatalog: nullRecipeCatalog,
  traceStore: nullTraceStore,
  appServices: stubAppServices({ ...appServicesOverrides }),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('POST /tasks/:id/question', () => {
  it('returns 200 { ok: true } and forwards the id + question to raiseTaskQuestion', async () => {
    const calls: Array<{ id: string; question: string }> = []
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        raiseTaskQuestion: async (id, question) => {
          calls.push({ id, question })
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/tasks/task-abc/question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'should I use approach A or B?' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(calls).toEqual([{ id: 'task-abc', question: 'should I use approach A or B?' }])
    } finally {
      await close()
    }
  })

  it('returns 400 when the body is missing question', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ raiseTaskQuestion: async () => {} }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/tasks/task-abc/question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 on invalid JSON body', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ raiseTaskQuestion: async () => {} }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/tasks/task-abc/question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 501 when raiseTaskQuestion is not implemented (dep omitted)', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/tasks/task-abc/question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'anything?' }),
      })
      expect(res.status).toBe(501)
    } finally {
      await close()
    }
  })

  it('returns 500 with the error message when raiseTaskQuestion throws', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        raiseTaskQuestion: async () => {
          throw new Error('outbox write failed')
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/tasks/task-abc/question`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'anything?' }),
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('outbox write failed')
    } finally {
      await close()
    }
  })
})

describe('raiseTaskQuestion (CLI client) — real HTTP boundary', () => {
  const repos: string[] = []
  afterEach(() => {
    while (repos.length > 0) {
      const dir = repos.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  /** A scratch `<repo>/.mars/` directory the client resolves against. */
  const makeRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mars-task-ask-client-'))
    repos.push(dir)
    return dir
  }

  it('posts the question to a live daemon and the server-side dep receives it', async () => {
    const calls: Array<{ id: string; question: string }> = []
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        raiseTaskQuestion: async (id, question) => {
          calls.push({ id, question })
        },
      }),
    )
    try {
      const repo = makeRepo()
      mkdirSync(join(repo, '.mars'), { recursive: true })
      writeFileSync(join(repo, '.mars', 'http.port'), String(port))

      const { raiseTaskQuestion } = await import('../client')
      await raiseTaskQuestion('task-xyz', 'is this the right worktree?', { repo })

      expect(calls).toEqual([{ id: 'task-xyz', question: 'is this the right worktree?' }])
    } finally {
      await close()
    }
  })

  it('throws the daemon-not-running message when no http.port file exists', async () => {
    const repo = makeRepo()
    const { raiseTaskQuestion } = await import('../client')
    await expect(
      raiseTaskQuestion('task-xyz', 'anyone there?', { repo }),
    ).rejects.toThrow(
      'task ask: daemon not running — run `mars daemon start` (questions are raised through the daemon)',
    )
  })
})
