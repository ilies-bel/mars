import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeSlimInit, purgeStaleSupervisorMds } from '../writer'
import {
  validateScopes,
} from '../render'

const slimInputFor = (root: string) => ({
  repoRoot: root,
  contextPath: resolve(root, 'CONTEXT.md'),
  adrDir: resolve(root, 'docs', 'adr'),
})

describe('writeSlimInit', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-slim-init-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates a CONTEXT.md skeleton when one is not already present', () => {
    writeSlimInit(slimInputFor(root))

    const contextPath = resolve(root, 'CONTEXT.md')
    expect(existsSync(contextPath)).toBe(true)
    const content = readFileSync(contextPath, 'utf8')
    expect(content).toContain('# Project Context')
    expect(content).toContain('## Language')
  })

  it('does not overwrite an existing CONTEXT.md', () => {
    const contextPath = resolve(root, 'CONTEXT.md')
    const existing = '# Project Context\n\n## Language\n\n**Foo**:\nbar.\n'
    mkdirSync(root, { recursive: true })
    writeFileSync(contextPath, existing, 'utf8')

    writeSlimInit(slimInputFor(root))

    expect(readFileSync(contextPath, 'utf8')).toBe(existing)
  })

  it('creates the docs/adr/ scaffold directory', () => {
    writeSlimInit(slimInputFor(root))

    const adrDir = resolve(root, 'docs', 'adr')
    expect(existsSync(adrDir)).toBe(true)
  })

  it('does not produce .mars/supervisors/<name>.md briefing files', () => {
    writeSlimInit(slimInputFor(root))

    const supervisorsDir = resolve(root, '.mars', 'supervisors')
    if (existsSync(supervisorsDir)) {
      const briefings = readdirSync(supervisorsDir).filter((e) =>
        e.endsWith('.md'),
      )
      expect(briefings).toEqual([])
    }
  })

})

describe('validateScopes', () => {
  it('returns an empty list when scopes is missing or empty', () => {
    expect(validateScopes(undefined)).toEqual([])
    expect(validateScopes(null)).toEqual([])
    expect(validateScopes([])).toEqual([])
  })

  it('rejects a scope entry missing path', () => {
    expect(() =>
      validateScopes([{ stack: 'node', verify: { test: 'npm test' } }]),
    ).toThrow(/path/)
  })

  it('rejects a scope entry missing stack', () => {
    expect(() =>
      validateScopes([{ path: '.', verify: { test: 'npm test' } }]),
    ).toThrow(/stack/)
  })

  it('rejects a scope entry missing verify map', () => {
    expect(() => validateScopes([{ path: '.', stack: 'node' }])).toThrow(
      /verify/,
    )
  })

  it('accepts a well-formed scope entry', () => {
    const scopes = validateScopes([
      { path: 'web', stack: 'react', verify: { test: 'vitest run' } },
    ])
    expect(scopes).toEqual([
      { path: 'web', stack: 'react', verify: { test: 'vitest run' } },
    ])
  })
})

describe('purgeStaleSupervisorMds', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-purge-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('deletes all .md files found in the supervisors dir', () => {
    const supervisorsDir = resolve(root, '.mars', 'supervisors')
    mkdirSync(supervisorsDir, { recursive: true })
    writeFileSync(resolve(supervisorsDir, 'node-backend-supervisor.md'), '# Node Backend\n')
    writeFileSync(resolve(supervisorsDir, 'react-supervisor.md'), '# React\n')

    purgeStaleSupervisorMds(supervisorsDir)

    expect(existsSync(resolve(supervisorsDir, 'node-backend-supervisor.md'))).toBe(false)
    expect(existsSync(resolve(supervisorsDir, 'react-supervisor.md'))).toBe(false)
  })

  it('returns the filenames of every purged file so the caller can print a summary', () => {
    const supervisorsDir = resolve(root, '.mars', 'supervisors')
    mkdirSync(supervisorsDir, { recursive: true })
    writeFileSync(resolve(supervisorsDir, 'foo-supervisor.md'), '# Foo\n')

    const { purged } = purgeStaleSupervisorMds(supervisorsDir)

    expect(purged).toEqual(['foo-supervisor.md'])
  })

  it('leaves non-.md files (manifest.json, detection-report.json) untouched', () => {
    const supervisorsDir = resolve(root, '.mars', 'supervisors')
    mkdirSync(supervisorsDir, { recursive: true })
    writeFileSync(resolve(supervisorsDir, 'manifest.json'), '{}')
    writeFileSync(resolve(supervisorsDir, 'detection-report.json'), '{}')
    writeFileSync(resolve(supervisorsDir, 'stale.md'), '# Stale\n')

    purgeStaleSupervisorMds(supervisorsDir)

    expect(existsSync(resolve(supervisorsDir, 'manifest.json'))).toBe(true)
    expect(existsSync(resolve(supervisorsDir, 'detection-report.json'))).toBe(true)
  })

  it('is a no-op when no .md files are present (second consecutive init)', () => {
    const supervisorsDir = resolve(root, '.mars', 'supervisors')
    mkdirSync(supervisorsDir, { recursive: true })
    writeFileSync(resolve(supervisorsDir, 'manifest.json'), '{}')

    const { purged } = purgeStaleSupervisorMds(supervisorsDir)

    expect(purged).toEqual([])
  })

  it('is a no-op when the supervisors directory does not exist', () => {
    const supervisorsDir = resolve(root, '.mars', 'supervisors')
    // directory intentionally absent

    const { purged } = purgeStaleSupervisorMds(supervisorsDir)

    expect(purged).toEqual([])
  })
})
