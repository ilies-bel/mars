/**
 * Tests for GET /recipes — serves the resolved recovery-recipe catalog
 * (built-in seed merged with `.mars/recipes/*.md` overrides). The HTTP
 * layer is a verbatim pass-through; these tests pin shape and override
 * propagation, mirroring the /failure-reasons tests.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog, recipesDir } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-rc-rec-')),
  )
})

const makeDeps = (
  overrides: Partial<HttpServerDeps> = {},
  recipeCatalogOverride?: Awaited<ReturnType<typeof loadRecipeCatalog>>,
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
  recipeCatalog:
    recipeCatalogOverride ??
    (cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>),
  traceStore: nullTraceStore,
  appServices: stubAppServices(),
  chatRunner: stubChatRunner(),
  ...overrides,
})

describe('GET /recipes', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(resolve(tmpdir(), 'mars-http-rc-'))
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('returns the built-in catalog as a JSON array when no overrides exist', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/recipes`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as Array<{
        name: string
        description: string
        tools: string[]
        prompt: string
        source: 'built-in' | 'override'
      }>
      expect(Array.isArray(body)).toBe(true)
      // All slice-E built-ins plus slice-F.2's `main-commiter`.
      const names = body.map((e) => e.name).sort()
      expect(names).toEqual(
        [
          'context-fetcher',
          'diagnose-only',
          'lint-autofix',
          'main-commiter',
          'merge-aborter',
          'prompt-tightener',
          'scope-narrower',
          'test-repairer',
          'typecheck-fixer',
        ].sort(),
      )
      for (const entry of body) {
        expect(entry.source).toBe('built-in')
        expect(typeof entry.prompt).toBe('string')
        expect(Array.isArray(entry.tools)).toBe(true)
      }
    } finally {
      await close()
    }
  })

  it('reflects overrides loaded from .mars/recipes/*.md', async () => {
    const dir = recipesDir(stateDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, 'typecheck-fixer.md'),
      `---
name: typecheck-fixer
description: Overridden description.
tools: [Bash]
---
# overridden
`,
      'utf8',
    )
    const overrideCatalog = await loadRecipeCatalog(stateDir)
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({}, overrideCatalog))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/recipes`)
      const body = (await res.json()) as Array<{
        name: string
        description: string
        source: string
      }>
      const tf = body.find((e) => e.name === 'typecheck-fixer')
      expect(tf?.description).toBe('Overridden description.')
      expect(tf?.source).toBe('override')
    } finally {
      await close()
    }
  })

  it('every entry has the five required fields', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/recipes`)
      const body = (await res.json()) as Array<Record<string, unknown>>
      for (const entry of body) {
        expect(typeof entry.name).toBe('string')
        expect(typeof entry.description).toBe('string')
        expect(Array.isArray(entry.tools)).toBe(true)
        expect(typeof entry.prompt).toBe('string')
        expect(typeof entry.source).toBe('string')
      }
    } finally {
      await close()
    }
  })
})
