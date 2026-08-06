/**
 * Tests for POST /actions/investigate/:id — the read-only Haiku triage action
 * for stale worktrees. Exercises HTTP routing and the response contract.
 *
 * The debounce guard (skip-if-already-running) lives in the server.ts closure
 * that wires up the investigateWorktree dep; the tests below verify the HTTP
 * layer only contracts through the public interface (fetch + response body).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-inv-rec-')),
  )
})

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-investigate-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

/** Build minimal deps with no-op defaults; override only what a test needs. */
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
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('POST /actions/investigate/:id', () => {
  let repo: string
  let httpServer: typeof import('../http-server')

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    const mod = await import('../http-server')
    httpServer = mod
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet: routing + explanation passthrough ─────────────────────

  it('routes POST /actions/investigate/:id to the investigateWorktree dep and returns explanation', async () => {
    let capturedId: string | null = null
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        investigateWorktree: async (id) => {
          capturedId = id
          return { explanation: 'The task was adding a new CLI flag.' }
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/investigate/mars-abc123`,
        { method: 'POST' },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; explanation: string }
      expect(body.ok).toBe(true)
      expect(body.explanation).toBe('The task was adding a new CLI flag.')
      expect(capturedId).toBe('mars-abc123')
    } finally {
      await close()
    }
  })

  // ── Draining guard applies to investigate too ────────────────────────────

  it('returns 503 when the daemon is draining', async () => {
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ isAcceptingWork: () => false }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/investigate/mars-xyz`,
        { method: 'POST' },
      )

      expect(res.status).toBe(503)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe('DRAINING')
    } finally {
      await close()
    }
  })

  // ── Error propagation ────────────────────────────────────────────────────

  it('returns 500 when the investigateWorktree dep throws', async () => {
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        investigateWorktree: async () => {
          throw new Error('git failed')
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/investigate/mars-fail`,
        { method: 'POST' },
      )

      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('git failed')
    } finally {
      await close()
    }
  })

  // ── The stale-worktree derived-row menu advertises the investigate action ──
  // Stale-worktree is not a `<failingStep>/<error-class>` failure, so its menu
  // lives in derived-row-actions.ts (ADR-0042), not in the signature-keyed
  // Failure-kind registry served over HTTP.

  it('derived-row menu includes investigate as a stale-worktree recovery action', async () => {
    const { derivedRowActions } = await import('../../lib/derived-row-actions')
    const actions = derivedRowActions('stale-worktree')
    const investigateAction = actions.find((a) => a.op === 'investigate')
    expect(investigateAction).toBeDefined()
    expect(investigateAction?.id).toBe('investigate')
  })
})

describe('POST /actions/diagnose-failure/:id', () => {
  let repo: string
  let httpServer: typeof import('../http-server')

  beforeEach(async () => {
    repo = setupRepo()
    process.env.MARS_REPO = repo
    httpServer = await import('../http-server')
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('routes to the diagnoseFailure dep and returns the diagnosis', async () => {
    let capturedId: string | null = null
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        diagnoseFailure: async (id) => {
          capturedId = id
          return { diagnosis: 'Migration ran twice; not an error per se.' }
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/diagnose-failure/mars-abc123`,
        { method: 'POST' },
      )

      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; diagnosis: string }
      expect(body.ok).toBe(true)
      expect(body.diagnosis).toBe('Migration ran twice; not an error per se.')
      expect(capturedId).toBe('mars-abc123')
    } finally {
      await close()
    }
  })

  it('returns 503 when the daemon is draining', async () => {
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ isAcceptingWork: () => false }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/diagnose-failure/mars-xyz`,
        { method: 'POST' },
      )

      expect(res.status).toBe(503)
      const body = (await res.json()) as { ok: boolean; errorCode: string }
      expect(body.ok).toBe(false)
      expect(body.errorCode).toBe('DRAINING')
    } finally {
      await close()
    }
  })

  it('returns 500 when the diagnoseFailure dep throws', async () => {
    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        diagnoseFailure: async () => {
          throw new Error('sonnet failed')
        },
      }),
    )

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/actions/diagnose-failure/mars-fail`,
        { method: 'POST' },
      )

      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toContain('sonnet failed')
    } finally {
      await close()
    }
  })

  it('failure-kinds registry includes diagnose-failure on a failed-task signature', async () => {
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/failure-kinds`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        failureKinds: Array<{
          signature: string
          actions: Array<{ op: string; id: string }>
        }>
      }
      // Every failed-task Failure kind offers Investigate (diagnose-failure),
      // the error-kind `failed-task` menu folded into the FailureKind record.
      const fk = body.failureKinds.find(
        (k) => k.signature === 'setup:install/install-frozen-lockfile',
      )
      expect(fk).toBeDefined()
      const diagnoseAction = fk?.actions.find((a) => a.op === 'diagnose-failure')
      expect(diagnoseAction).toBeDefined()
      expect(diagnoseAction?.id).toBe('diagnose-failure')
    } finally {
      await close()
    }
  })
})
