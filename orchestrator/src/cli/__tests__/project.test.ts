/**
 * Integration tests for `mars project` subcommand routing, plus unit tests
 * for the saveProjectRegistry chokepoint guard.
 *
 * Uses MARS_PROJECTS_FILE to redirect the registry to a temp file so
 * tests never touch ~/.mars/projects.json.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addProject,
  removeProject,
  ensureProjectRegistered,
} from '../../registry/projects.js'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

let tmpDir: string
let registryFile: string
let repoDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-project-test-'))
  registryFile = resolve(tmpDir, 'projects.json')
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-fake-repo-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

const runCli = (
  args: readonly string[],
  extraEnv?: Record<string, string>,
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MARS_PROJECTS_FILE: registryFile,
      ...extraEnv,
    },
    timeout: 15_000,
  })

describe('mars project list — empty registry', () => {
  it('exits 0 and prints "(no projects registered)"', () => {
    const result = runCli(['project', 'list'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('(no projects registered)')
  })
})

describe('mars project add', () => {
  it('exits 0 and prints a projectId when given an existing directory', () => {
    const result = runCli(['project', 'add', repoDir])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toMatch(/^p_[0-9a-f]{12}$/)
  })

  it('exits 1 when the directory does not exist', () => {
    const result = runCli(['project', 'add', '/nonexistent/path/that/cannot/exist'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('does not exist')
  })

  it('exits 1 on duplicate repoRoot', () => {
    // First add succeeds
    const first = runCli(['project', 'add', repoDir])
    expect(first.status).toBe(0)
    // Second add with same path errors
    const second = runCli(['project', 'add', repoDir])
    expect(second.status).toBe(1)
    expect(second.stderr).toMatch(/already registered/i)
  })

  it('accepts --name and registers with that label', () => {
    const result = runCli(['project', 'add', repoDir, '--name', 'my-label'])
    expect(result.status).toBe(0)
    // After adding, list should show the label
    const list = runCli(['project', 'list'])
    expect(list.stdout).toContain('my-label')
  })
})

describe('mars project list — after adding a project', () => {
  it('shows projectId, name, and repoRoot in columns', () => {
    const addResult = runCli(['project', 'add', repoDir, '--name', 'test-proj'])
    expect(addResult.status).toBe(0)
    const projectId = addResult.stdout.trim()

    const listResult = runCli(['project', 'list'])
    expect(listResult.status).toBe(0)
    expect(listResult.stdout).toContain(projectId)
    expect(listResult.stdout).toContain('test-proj')
    expect(listResult.stdout).toContain(repoDir)
  })
})

describe('mars project remove', () => {
  it('prints "removed <id>" and exits 0 for a known projectId', () => {
    const addResult = runCli(['project', 'add', repoDir])
    expect(addResult.status).toBe(0)
    const projectId = addResult.stdout.trim()

    const removeResult = runCli(['project', 'remove', projectId])
    expect(removeResult.status).toBe(0)
    expect(removeResult.stdout.trim()).toBe(`removed ${projectId}`)
  })

  it('prints "no such project: <id>" for an unknown projectId', () => {
    const result = runCli(['project', 'remove', 'p_000000000000'])
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('no such project: p_000000000000')
  })

  it('makes the entry disappear from list', () => {
    const addResult = runCli(['project', 'add', repoDir])
    const projectId = addResult.stdout.trim()
    runCli(['project', 'remove', projectId])

    const listResult = runCli(['project', 'list'])
    expect(listResult.stdout.trim()).toBe('(no projects registered)')
  })
})

describe('mars project --help', () => {
  it('exits 0 and documents add, list, and remove verbs', () => {
    const result = runCli(['project', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('add')
    expect(result.stdout).toContain('list')
    expect(result.stdout).toContain('remove')
  })

  it('documents the --name flag', () => {
    const result = runCli(['project', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--name')
  })
})

// ---------------------------------------------------------------------------
// Unit tests for the saveProjectRegistry chokepoint guard.
//
// These tests import the registry functions directly (not via the CLI
// subprocess) so they run in the Vitest process where VITEST is set.
// ---------------------------------------------------------------------------

describe('saveProjectRegistry chokepoint guard — VITEST without MARS_PROJECTS_FILE', () => {
  let savedProjectsFile: string | undefined

  beforeEach(() => {
    // The global setup-env.ts has already set MARS_PROJECTS_FILE to a temp
    // path before this beforeEach runs. Save and delete it so the guard
    // condition (VITEST set, MARS_PROJECTS_FILE unset) fires.
    savedProjectsFile = process.env.MARS_PROJECTS_FILE
    delete process.env.MARS_PROJECTS_FILE
  })

  afterEach(() => {
    // Restore so subsequent tests and setup-env.ts's ??= guard are consistent.
    if (savedProjectsFile !== undefined) {
      process.env.MARS_PROJECTS_FILE = savedProjectsFile
    } else {
      delete process.env.MARS_PROJECTS_FILE
    }
  })

  it('addProject throws the registry-violation error', () => {
    // repoDir is created by the outer beforeEach; it is unique per-run so
    // it cannot collide with any real entry in ~/.mars/projects.json.
    expect(() => addProject({ repoRoot: repoDir })).toThrow('[mars-test registry violation]')
  })

  it('addProject error names the real registry path and the fix', () => {
    let message = ''
    try {
      addProject({ repoRoot: repoDir })
    } catch (err) {
      message = String(err)
    }
    expect(message).toContain('projects.json')
    expect(message).toContain('MARS_PROJECTS_FILE')
    expect(message).toContain('setup-env.ts')
  })

  it('ensureProjectRegistered returns a synthesised entry without throwing', () => {
    // ensureProjectRegistered short-circuits before saveProjectRegistry
    // when VITEST is set and MARS_PROJECTS_FILE is unset.
    const entry = ensureProjectRegistered({ repoRoot: repoDir })
    expect(entry.repoRoot).toBe(repoDir)
    expect(entry.projectId).toMatch(/^p_[0-9a-f]{12}$/)
  })
})

describe('saveProjectRegistry — normal operation with MARS_PROJECTS_FILE set', () => {
  let ownTmpDir: string
  let ownRegistry: string

  beforeEach(() => {
    ownTmpDir = mkdtempSync(resolve(tmpdir(), 'mars-guard-ok-test-'))
    ownRegistry = resolve(ownTmpDir, 'projects.json')
    process.env.MARS_PROJECTS_FILE = ownRegistry
  })

  afterEach(() => {
    rmSync(ownTmpDir, { recursive: true, force: true })
    // Delete so setup-env.ts's ??= in the next beforeEach restores the default
    // per-run temp path and doesn't see a path to a deleted directory.
    delete process.env.MARS_PROJECTS_FILE
  })

  it('addProject writes to the temp file and returns the new entry', () => {
    const entry = addProject({ repoRoot: repoDir })
    expect(entry.projectId).toMatch(/^p_[0-9a-f]{12}$/)
    expect(entry.repoRoot).toBe(repoDir)
  })

  it('removeProject removes an existing entry and returns true', () => {
    const entry = addProject({ repoRoot: repoDir })
    const removed = removeProject(entry.projectId)
    expect(removed).toBe(true)
  })

  it('removeProject returns false without writing when the project is not found', () => {
    const removed = removeProject('p_000000000000')
    expect(removed).toBe(false)
  })
})
