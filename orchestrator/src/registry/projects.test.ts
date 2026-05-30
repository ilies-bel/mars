import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadProjectRegistry,
  addProject,
  removeProject,
  findProject,
  ensureProjectRegistered,
} from './projects.js'

const tmpDir = join(tmpdir(), `mars-registry-test-${process.pid}`)

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true })
  process.env.MARS_PROJECTS_FILE = join(tmpDir, 'projects.json')
})

afterEach(() => {
  delete process.env.MARS_PROJECTS_FILE
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('loadProjectRegistry — absent / empty / malformed', () => {
  it('returns [] when the file is missing', () => {
    expect(loadProjectRegistry()).toEqual([])
  })

  it('returns [] when the file is empty', () => {
    writeFileSync(join(tmpDir, 'projects.json'), '')
    expect(loadProjectRegistry()).toEqual([])
  })

  it('throws on malformed JSON', () => {
    writeFileSync(join(tmpDir, 'projects.json'), 'not-valid-json{{{')
    expect(() => loadProjectRegistry()).toThrow()
  })

  it('throws when an entry has a relative repoRoot (schema violation)', () => {
    writeFileSync(
      join(tmpDir, 'projects.json'),
      JSON.stringify([{ projectId: 'p_abc123def456', repoRoot: 'relative/path', name: 'test' }]),
    )
    expect(() => loadProjectRegistry()).toThrow()
  })
})

describe('addProject / loadProjectRegistry — round-trip', () => {
  it('stores and retrieves a project', () => {
    const entry = addProject({ repoRoot: '/tmp/my-project', name: 'My Project' })

    expect(entry.projectId).toMatch(/^p_[a-f0-9]{12}$/)
    expect(entry.repoRoot).toBe('/tmp/my-project')
    expect(entry.name).toBe('My Project')
    expect(loadProjectRegistry()).toEqual([entry])
  })

  it('derives name from basename when omitted', () => {
    const entry = addProject({ repoRoot: '/tmp/my-project' })
    expect(entry.name).toBe('my-project')
  })

  it('derives a deterministic projectId for the same repoRoot', () => {
    const e1 = addProject({ repoRoot: '/tmp/proj-deterministic' })
    removeProject(e1.projectId)
    const e2 = addProject({ repoRoot: '/tmp/proj-deterministic' })
    expect(e2.projectId).toBe(e1.projectId)
  })

  it('rejects duplicate repoRoot', () => {
    addProject({ repoRoot: '/tmp/my-project' })
    expect(() => addProject({ repoRoot: '/tmp/my-project' })).toThrow(/already registered/)
  })
})

describe('removeProject', () => {
  it('removes an existing project and returns true', () => {
    const entry = addProject({ repoRoot: '/tmp/my-project' })
    expect(removeProject(entry.projectId)).toBe(true)
    expect(loadProjectRegistry()).toEqual([])
  })

  it('returns false for an unknown projectId', () => {
    expect(removeProject('p_doesnotexist')).toBe(false)
  })
})

describe('findProject', () => {
  it('returns the entry for a known projectId', () => {
    const entry = addProject({ repoRoot: '/tmp/my-project' })
    expect(findProject(entry.projectId)).toEqual(entry)
  })

  it('returns null for an unknown projectId', () => {
    expect(findProject('p_doesnotexist')).toBeNull()
  })
})

describe('ensureProjectRegistered', () => {
  it('registers a repo when the registry is empty and returns the new entry', () => {
    const entry = ensureProjectRegistered({ repoRoot: '/tmp/my-project' })

    expect(entry.projectId).toMatch(/^p_[a-f0-9]{12}$/)
    expect(entry.repoRoot).toBe('/tmp/my-project')
    expect(loadProjectRegistry()).toEqual([entry])
  })

  it('calling twice does not duplicate the entry', () => {
    ensureProjectRegistered({ repoRoot: '/tmp/my-project' })
    ensureProjectRegistered({ repoRoot: '/tmp/my-project' })

    expect(loadProjectRegistry()).toHaveLength(1)
  })

  it('returns the existing entry unchanged when already registered', () => {
    const first = ensureProjectRegistered({ repoRoot: '/tmp/my-project', name: 'original' })
    const second = ensureProjectRegistered({ repoRoot: '/tmp/my-project', name: 'ignored' })

    expect(second).toEqual(first)
    expect(loadProjectRegistry()).toHaveLength(1)
  })

  it('does not throw when the repo is already registered', () => {
    addProject({ repoRoot: '/tmp/my-project' })
    expect(() => ensureProjectRegistered({ repoRoot: '/tmp/my-project' })).not.toThrow()
  })

  it('registers two different repos without conflict', () => {
    ensureProjectRegistered({ repoRoot: '/tmp/project-a' })
    ensureProjectRegistered({ repoRoot: '/tmp/project-b' })

    const entries = loadProjectRegistry()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.repoRoot)).toContain('/tmp/project-a')
    expect(entries.map((e) => e.repoRoot)).toContain('/tmp/project-b')
  })
})
