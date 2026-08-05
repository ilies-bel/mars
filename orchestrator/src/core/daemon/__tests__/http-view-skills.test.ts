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
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-http-view-skills-'))
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
      mkdtempSync(resolve(tmpdir(), 'mars-http-skl-rec-')),
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
  restartAllDaemonKilled: async () => [],
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

describe('GET /view/skills', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty skills array when no .claude/skills directory exists', async () => {
    const { httpServer } = await loadModules(repo)
    const { port, close } = await httpServer.startHttpServer(makeDeps())

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/skills`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { skills: unknown[] }
      expect(body.skills).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns skill data from injected viewSkills', async () => {
    const { httpServer } = await loadModules(repo)

    const fixture = {
      skills: [
        { name: 'task', description: 'Light terminology check then enqueue as a task.', path: '/repo/.claude/skills/task/SKILL.md' },
        { name: 'grill', description: 'Grilling session that challenges the user\'s plan.', path: '/repo/.claude/skills/grill/SKILL.md' },
      ],
    }

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({ viewSkills: async () => fixture }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/skills`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as typeof fixture
      expect(body.skills).toHaveLength(2)
      expect(body.skills[0]?.name).toBe('task')
      expect(body.skills[0]?.description).toBe('Light terminology check then enqueue as a task.')
      expect(body.skills[1]?.name).toBe('grill')
    } finally {
      await close()
    }
  })

  it('returns 500 when viewSkills throws', async () => {
    const { httpServer } = await loadModules(repo)

    const { port, close } = await httpServer.startHttpServer(
      makeDeps({
        viewSkills: async () => {
          throw new Error('skills unavailable')
        },
      }),
    )

    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/skills`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('skills unavailable')
    } finally {
      await close()
    }
  })

  it('discovers skills from fixture .claude/skills directory via real viewSkills', async () => {
    // Set up fixture skill files in the temp repo
    const skillsBase = resolve(repo, '.claude', 'skills')
    mkdirSync(resolve(skillsBase, 'deploy'), { recursive: true })
    mkdirSync(resolve(skillsBase, 'review'), { recursive: true })

    writeFileSync(
      resolve(skillsBase, 'deploy', 'SKILL.md'),
      [
        '---',
        'name: deploy',
        'description: Deploy the app to production.',
        '---',
        '',
        '# Deploy skill body',
      ].join('\n'),
      'utf8',
    )

    writeFileSync(
      resolve(skillsBase, 'review', 'SKILL.md'),
      [
        '---',
        'name: review',
        'description: Review a pull request for correctness.',
        '---',
        '',
        '# Review skill body',
      ].join('\n'),
      'utf8',
    )

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

    const result = await appServices.viewSkills()
    expect(result.skills.length).toBe(2)

    const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]))
    expect(byName['deploy']?.description).toBe('Deploy the app to production.')
    expect(byName['deploy']?.path).toContain('deploy')
    expect(byName['deploy']?.path).toContain('SKILL.md')
    expect(byName['review']?.description).toBe('Review a pull request for correctness.')
  })

  it('tolerates malformed SKILL.md with empty description instead of failing', async () => {
    // Skill directory exists but SKILL.md has no frontmatter
    const skillsBase = resolve(repo, '.claude', 'skills')
    mkdirSync(resolve(skillsBase, 'broken'), { recursive: true })

    writeFileSync(
      resolve(skillsBase, 'broken', 'SKILL.md'),
      '# No frontmatter here\n\nJust body text.',
      'utf8',
    )

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

    const result = await appServices.viewSkills()
    expect(result.skills).toHaveLength(1)
    // Falls back to directory name as skill name, empty description
    expect(result.skills[0]?.name).toBe('broken')
    expect(result.skills[0]?.description).toBe('')
  })

  it('tolrates missing SKILL.md with empty description instead of failing', async () => {
    // Skill directory exists but has no SKILL.md
    const skillsBase = resolve(repo, '.claude', 'skills')
    mkdirSync(resolve(skillsBase, 'nofile'), { recursive: true })
    // intentionally NOT creating SKILL.md

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

    const result = await appServices.viewSkills()
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]?.name).toBe('nofile')
    expect(result.skills[0]?.description).toBe('')
  })
})
