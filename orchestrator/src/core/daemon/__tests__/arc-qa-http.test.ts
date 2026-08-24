/**
 * Tests for GET /arc/:originId/qa and
 * GET /arc/:originId/qa/screenshot/:criterionIndex/:stepIndex routes.
 *
 * Each test boots a real HTTP server backed by a tmp git repo so the
 * context resolver can find `.mars/`. Files are written directly to the
 * tmp repo's `.mars/arc-qa/` tree.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'
import type { ArcQaManifest } from '../../lib/arc-qa-manifest'

// ── Helpers ───────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-arc-qa-http-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

const ensureCatalogs = async (): Promise<void> => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-arc-qa-rec-')),
    )
  }
}

const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
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
  enableAutoReflect: async () => {},
  disableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog!,
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

/** Write a minimal but valid ArcQaManifest to disk. */
const writeManifest = (repo: string, originId: string, manifest: ArcQaManifest): void => {
  const dir = resolve(repo, '.mars', 'arc-qa', originId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

/** Write a PNG-ish stub file for screenshot tests. */
const writeScreenshot = (
  repo: string,
  originId: string,
  criterionIndex: number,
  stepIndex: number,
  content: Buffer = Buffer.from('PNG-stub'),
): void => {
  const dir = resolve(repo, '.mars', 'arc-qa', originId, String(criterionIndex))
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${stepIndex}.png`), content)
}

const SAMPLE_MANIFEST: ArcQaManifest = {
  originId: 'arc-001',
  generatedAt: 1_700_000_000_000,
  criteria: [
    {
      criterion: 'Login form renders',
      steps: [
        { index: 0, text: 'Navigate to /login', screenshotPath: '0/0.png' },
      ],
      stoppedAtStep: null,
      stopReason: null,
    },
  ],
}

// ── Test suites ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensureCatalogs()
})

describe('GET /arc/:originId/qa', () => {
  let repo: string
  let startHttpServer: typeof import('../http-server').startHttpServer

  beforeEach(async () => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
    const httpMod = await import('../http-server')
    startHttpServer = httpMod.startHttpServer
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 200 with manifest JSON when the file exists', async () => {
    writeManifest(repo, 'arc-001', SAMPLE_MANIFEST)
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/arc-001/qa`)
      expect(res.status).toBe(200)
      const body = await res.json() as ArcQaManifest
      expect(body.originId).toBe('arc-001')
      expect(body.criteria).toHaveLength(1)
      expect(body.criteria[0]?.criterion).toBe('Login form renders')
    } finally {
      await close()
    }
  })

  it('returns 404 with {error:"no manifest"} when file is absent', async () => {
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/arc-missing/qa`)
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('no manifest')
    } finally {
      await close()
    }
  })

  it('returns 400 when originId contains ".."', async () => {
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/..%2Fetc/qa`)
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })
})

describe('GET /arc/:originId/qa/screenshot/:criterionIndex/:stepIndex', () => {
  let repo: string
  let startHttpServer: typeof import('../http-server').startHttpServer

  beforeEach(async () => {
    repo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = repo
    const httpMod = await import('../http-server')
    startHttpServer = httpMod.startHttpServer
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('streams PNG bytes with Content-Type image/png when file exists', async () => {
    const pngStub = Buffer.from('\x89PNG\r\n\x1a\n', 'binary')
    writeScreenshot(repo, 'arc-001', 0, 0, pngStub)
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/arc-001/qa/screenshot/0/0`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      const bytes = Buffer.from(await res.arrayBuffer())
      expect(bytes).toEqual(pngStub)
    } finally {
      await close()
    }
  })

  it('returns 404 when screenshot file does not exist', async () => {
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/arc-001/qa/screenshot/0/99`)
      expect(res.status).toBe(404)
    } finally {
      await close()
    }
  })

  it('returns 400 when criterionIndex is not a digit string', async () => {
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/arc-001/qa/screenshot/abc/0`)
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 when stepIndex is not a digit string', async () => {
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/arc-001/qa/screenshot/0/abc`)
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 when criterionIndex contains ".."', async () => {
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/arc-001/qa/screenshot/..%2F0/0`)
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })

  it('returns 400 when originId contains ".."', async () => {
    const { port, address, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://${address}:${port}/arc/..%2Farc/qa/screenshot/0/0`)
      expect(res.status).toBe(400)
    } finally {
      await close()
    }
  })
})
