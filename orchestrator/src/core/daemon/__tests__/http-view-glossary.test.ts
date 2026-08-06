import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { vi } from 'vitest'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-view-glossary-'))
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

let cachedRecipeCatalog: Awaited<ReturnType<typeof loadRecipeCatalog>> | null = null

const ensureCatalogs = async (): Promise<void> => {
  if (!cachedRecipeCatalog) {
    cachedRecipeCatalog = await loadRecipeCatalog(
      mkdtempSync(resolve(tmpdir(), 'mars-http-gls-rec-')),
    )
  }
}

const makeDeps = (
  appServicesOverrides: Partial<AppServices> = {},
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
  recipeCatalog: cachedRecipeCatalog!,
  traceStore: nullTraceStore,
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

beforeAll(async () => {
  await ensureCatalogs()
})

describe('GET /view/glossary', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty terms array when no CONTEXT.md exists', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/glossary`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { terms: unknown[] }
      expect(body.terms).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns glossary terms from injected viewGlossary', async () => {
    const { httpServer } = await loadModules(repo)

    const fixture = {
      terms: [
        { term: 'Arc', definition: 'A chain of tasks sharing an originId.', avoid: ['chain', 'pipeline'], surfaceForms: ['arc', 'arcs'] },
        { term: 'Task', definition: 'A unit of work managed by the orchestrator.', avoid: [], surfaceForms: ['task', 'tasks'] },
      ],
    }

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewGlossary: async () => fixture }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/glossary`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as typeof fixture
      expect(body.terms).toHaveLength(2)
      expect(body.terms[0]?.term).toBe('Arc')
      expect(body.terms[0]?.definition).toBe('A chain of tasks sharing an originId.')
      expect(body.terms[0]?.avoid).toEqual(['chain', 'pipeline'])
      expect(body.terms[0]?.surfaceForms).toEqual(['arc', 'arcs'])
      expect(body.terms[1]?.term).toBe('Task')
      expect(body.terms[1]?.avoid).toEqual([])
      expect(body.terms[1]?.surfaceForms).toEqual(['task', 'tasks'])
    } finally {
      await close()
    }
  })

  it('returns 500 when viewGlossary throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewGlossary: async () => {
          throw new Error('glossary unavailable')
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/glossary`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('glossary unavailable')
    } finally {
      await close()
    }
  })

  it('parses CONTEXT.md from disk via the real viewGlossary implementation', async () => {
    // Write a fixture CONTEXT.md in the temp repo
    const contextMd = [
      '# Project Context',
      '',
      'Canonical domain terms.',
      '',
      '## Language',
      '',
      '**Worktree**: An isolated git working tree for a task.',
      '_Avoid_: branch, sandbox',
      '',
      '**Task**: A unit of work managed by the orchestrator.',
    ].join('\n')
    writeFileSync(resolve(repo, 'CONTEXT.md'), contextMd, 'utf8')

    // Import the real app-services with the temp repo as MARS_REPO
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { createAppServices } = (await import(
      '../../app-services'
    )) as typeof import('../../app-services')
    const { nullTraceStore: nts } = (await import(
      '../../lib/run-tool'
    )) as typeof import('../../lib/run-tool')
    const appServices = createAppServices({
      traceStore: nts,
      buildAlertSources: async () => ({ listFailedArcs: async () => [], listStaleWorktrees: async () => [], listVerifyUncovered: async () => [] }),
    })

    const result = await appServices.viewGlossary()
    expect(result.terms).toHaveLength(2)
    expect(result.terms[0]?.term).toBe('Worktree')
    expect(result.terms[0]?.definition).toBe('An isolated git working tree for a task.')
    expect(result.terms[0]?.avoid).toEqual(['branch', 'sandbox'])
    expect(result.terms[0]?.surfaceForms).toContain('worktree')
    expect(result.terms[1]?.term).toBe('Task')
    expect(result.terms[1]?.avoid).toEqual([])
    expect(result.terms[1]?.surfaceForms).toContain('task')
  })
})
