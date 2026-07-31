/**
 * Tests for createProjectContextCache (ui/server/projectContext.ts).
 *
 * Verifies:
 *   1. Default-project context resolves to the supplied defaultRepo.
 *   2. Memoisation: two calls with the same key return the same handles.
 *   3. Unknown projectId rejects with UnknownProjectError.
 *   4. A known projectId resolves to that project's repoRoot.
 *   5. Different projectIds get separate contexts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createProjectContextCache, readProjectAdr } from './projectContext.ts'
import { UnknownProjectError } from './repo.ts'

const makeRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-pctx-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

describe('createProjectContextCache', () => {
  let repo: string
  let origRegistryFile: string | undefined

  beforeEach(() => {
    repo = makeRepo()
    origRegistryFile = process.env.MARS_PROJECTS_FILE
  })

  afterEach(() => {
    if (origRegistryFile !== undefined) {
      process.env.MARS_PROJECTS_FILE = origRegistryFile
    } else {
      delete process.env.MARS_PROJECTS_FILE
    }
    rmSync(repo, { recursive: true, force: true })
  })

  it('resolves to the default repo when no projectId is given', async () => {
    const getProjectContext = createProjectContextCache(repo)
    const pctx = await getProjectContext(undefined)
    expect(pctx.ctx.repoRoot).toBe(repo)
    expect(pctx.db).toBeDefined()
    expect(pctx.stateDb).toBeDefined()
    expect(pctx.hub).toBeDefined()
  })

  it('memoises: two calls with no projectId return the same handles', async () => {
    const getProjectContext = createProjectContextCache(repo)
    const first = await getProjectContext(undefined)
    const second = await getProjectContext(undefined)
    expect(first).toBe(second)
  })

  it('rejects with UnknownProjectError for an unregistered projectId', async () => {
    const registryFile = resolve(repo, 'projects.json')
    writeFileSync(registryFile, '[]')
    process.env.MARS_PROJECTS_FILE = registryFile

    const getProjectContext = createProjectContextCache(repo)
    await expect(getProjectContext('p_nonexistent')).rejects.toBeInstanceOf(UnknownProjectError)
  })

  it('rejection message includes the unknown projectId', async () => {
    const registryFile = resolve(repo, 'projects.json')
    writeFileSync(registryFile, '[]')
    process.env.MARS_PROJECTS_FILE = registryFile

    const getProjectContext = createProjectContextCache(repo)
    await expect(getProjectContext('p_missing123')).rejects.toThrow('unknown project: p_missing123')
  })

  it('resolves to a registered project repoRoot when a valid projectId is given', async () => {
    const otherRepo = makeRepo()
    try {
      const registryFile = resolve(repo, 'projects.json')
      writeFileSync(
        registryFile,
        JSON.stringify([{ projectId: 'p_abc123456789', repoRoot: otherRepo, name: 'other' }]),
      )
      process.env.MARS_PROJECTS_FILE = registryFile

      const getProjectContext = createProjectContextCache(repo)
      const pctx = await getProjectContext('p_abc123456789')
      expect(pctx.ctx.repoRoot).toBe(otherRepo)
    } finally {
      rmSync(otherRepo, { recursive: true, force: true })
    }
  })

  it('different projectIds get distinct contexts', async () => {
    const otherRepo = makeRepo()
    try {
      const registryFile = resolve(repo, 'projects.json')
      writeFileSync(
        registryFile,
        JSON.stringify([{ projectId: 'p_other123456', repoRoot: otherRepo, name: 'other' }]),
      )
      process.env.MARS_PROJECTS_FILE = registryFile

      const getProjectContext = createProjectContextCache(repo)
      const defaultCtx = await getProjectContext(undefined)
      const projectCtx = await getProjectContext('p_other123456')

      expect(defaultCtx).not.toBe(projectCtx)
      expect(defaultCtx.ctx.repoRoot).toBe(repo)
      expect(projectCtx.ctx.repoRoot).toBe(otherRepo)
    } finally {
      rmSync(otherRepo, { recursive: true, force: true })
    }
  })
})

describe('readProjectAdr', () => {
  it('reads an ADR at the path derived from its number and slug', () => {
    const repo = makeRepo()
    try {
      mkdirSync(resolve(repo, 'docs', 'adr'), { recursive: true })
      writeFileSync(resolve(repo, 'docs', 'adr', '0042-keep-the-rail-focused.md'), '# Keep the rail focused')

      expect(
        readProjectAdr(
          { repoRoot: repo } as Parameters<typeof readProjectAdr>[0],
          'docs/adr/0042-keep-the-rail-focused.md',
        ),
      ).toBe('# Keep the rail focused')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
