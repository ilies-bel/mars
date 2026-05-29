/**
 * Tests for GET /failure-reasons — serves the resolved failure-reason
 * catalog (built-in seed merged with `.mars/failure-reasons/*.yaml`
 * overrides). The HTTP layer is a verbatim pass-through; these tests pin
 * shape and override propagation.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import {
  codeToFilename,
  failureReasonsDir,
  loadFailureReasonCatalog,
} from '../../lib/failure-reasons'
import { loadRecipeCatalog } from '../../lib/recipes'
import { BUILT_IN_FAILURE_REASONS } from '../../failure-reasons/built-in'
import { nullTraceStore } from '../../lib/run-tool'

let cachedCatalog: Awaited<ReturnType<typeof loadFailureReasonCatalog>> | null = null
let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null
beforeAll(async () => {
  cachedCatalog = await loadFailureReasonCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-fr-cat-')),
  )
  cachedRecipeCatalog = await loadRecipeCatalog(
    mkdtempSync(resolve(tmpdir(), 'mars-http-fr-rec-')),
  )
})

const makeDeps = (
  overrides: Partial<HttpServerDeps> = {},
  catalogOverride?: Awaited<ReturnType<typeof loadFailureReasonCatalog>>,
): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  failureReasonCatalog:
    catalogOverride ?? (cachedCatalog as Awaited<ReturnType<typeof loadFailureReasonCatalog>>),
  recipeCatalog: cachedRecipeCatalog as Awaited<ReturnType<typeof loadRecipeCatalog>>,
  traceStore: nullTraceStore,
  viewTasks: async () => ({ tasks: [] }),
  ...overrides,
})

describe('GET /failure-reasons', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(resolve(tmpdir(), 'mars-http-fr-'))
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('returns the built-in catalog as a JSON array when no overrides exist', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/failure-reasons`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as Array<{ code: string }>
      expect(Array.isArray(body)).toBe(true)
      const codes = body.map((e) => e.code).sort()
      const builtInCodes = BUILT_IN_FAILURE_REASONS.map((e) => e.code).sort()
      expect(codes).toEqual(builtInCodes)
    } finally {
      await close()
    }
  })

  it('reflects overrides loaded from .mars/failure-reasons/*.yaml', async () => {
    const dir = failureReasonsDir(stateDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, codeToFilename('verify:typecheck')),
      `code: verify:typecheck\nuserMessage: Overridden message.\nrecipe: my-recipe\navailableActions:\n  - id: restart\n    label: Restart\n    cliHint: mars restart <id>\n`,
      'utf8',
    )
    const overrideCatalog = await loadFailureReasonCatalog(stateDir)
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps({}, overrideCatalog))
    try {
      const res = await fetch(`http://127.0.0.1:${port}/failure-reasons`)
      const body = (await res.json()) as Array<{
        code: string
        userMessage: string
        recipe: string | null
      }>
      const typecheck = body.find((e) => e.code === 'verify:typecheck')
      expect(typecheck?.userMessage).toBe('Overridden message.')
      expect(typecheck?.recipe).toBe('my-recipe')
    } finally {
      await close()
    }
  })

  it('every entry has the four required fields', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(makeDeps())
    try {
      const res = await fetch(`http://127.0.0.1:${port}/failure-reasons`)
      const body = (await res.json()) as Array<Record<string, unknown>>
      for (const entry of body) {
        expect(typeof entry.code).toBe('string')
        expect(typeof entry.userMessage).toBe('string')
        expect(['string', 'object']).toContain(typeof entry.recipe) // string or null
        expect(Array.isArray(entry.availableActions)).toBe(true)
      }
    } finally {
      await close()
    }
  })
})
