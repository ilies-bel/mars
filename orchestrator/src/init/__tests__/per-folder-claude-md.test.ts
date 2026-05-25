import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectStack, type SupervisorSpec } from '../detect-stack'
import { loadCatalogue, lookupCatalogue } from '../per-stack-catalogue'
import { writePerFolderClaudeMds } from '../writer'

const make = (root: string, files: Record<string, string>): void => {
  for (const [rel, body] of Object.entries(files)) {
    const path = resolve(root, rel)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
}

describe('writePerFolderClaudeMds', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-per-folder-claude-md-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes one CLAUDE.md per detected manifest directory (tracer bullet)', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
      'backend/package.json': JSON.stringify({
        dependencies: { express: '*' },
      }),
    })

    const detected = detectStack(root)
    const result = writePerFolderClaudeMds({
      repoRoot: root,
      supervisors: detected.supervisors,
    })

    expect(existsSync(resolve(root, 'frontend', 'CLAUDE.md'))).toBe(true)
    expect(existsSync(resolve(root, 'backend', 'CLAUDE.md'))).toBe(true)
    expect(result.written).toHaveLength(2)
  })

  it("each CLAUDE.md's content equals the catalogue entry for its supervisor", () => {
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
      'api/package.json': JSON.stringify({
        dependencies: { express: '*' },
      }),
    })

    const detected = detectStack(root)
    writePerFolderClaudeMds({ repoRoot: root, supervisors: detected.supervisors })

    const catalogue = loadCatalogue()

    const reactSpec = detected.supervisors.find((s) => s.name === 'react-supervisor')
    expect(reactSpec).toBeDefined()
    const frontendContent = readFileSync(resolve(root, 'frontend', 'CLAUDE.md'), 'utf8')
    expect(frontendContent).toBe(lookupCatalogue(catalogue, 'react-supervisor'))

    const nodeSpec = detected.supervisors.find((s) => s.name === 'node-backend-supervisor')
    expect(nodeSpec).toBeDefined()
    const apiContent = readFileSync(resolve(root, 'api', 'CLAUDE.md'), 'utf8')
    expect(apiContent).toBe(lookupCatalogue(catalogue, 'node-backend-supervisor'))
  })

  it('unknown supervisor name receives the generic baseline content', () => {
    const unknownSupervisors: SupervisorSpec[] = [
      {
        name: 'unknown-wizard-supervisor',
        persona: 'X',
        kind: 'specialized',
        scope: 'tools/',
        detectedFrom: ['tools/wizard.toml'],
        externalSlugs: [],
        techs: [],
      },
    ]
    mkdirSync(resolve(root, 'tools'), { recursive: true })

    writePerFolderClaudeMds({ repoRoot: root, supervisors: unknownSupervisors })

    const catalogue = loadCatalogue()
    const content = readFileSync(resolve(root, 'tools', 'CLAUDE.md'), 'utf8')
    expect(content).toBe(lookupCatalogue(catalogue, 'generic'))
    // Also verify it's the baseline content, not empty
    expect(content.length).toBeGreaterThan(0)
    expect(content).toContain('Generic Supervisor')
  })

  it('skips root-scope (.) supervisors — root CLAUDE.md is handled by scaffold', () => {
    const rootSupervisors: SupervisorSpec[] = [
      {
        name: 'node-backend-supervisor',
        persona: 'Nina',
        kind: 'backend',
        scope: '.',
        detectedFrom: ['package.json'],
        externalSlugs: [],
        techs: ['node'],
      },
    ]

    writePerFolderClaudeMds({ repoRoot: root, supervisors: rootSupervisors })

    expect(existsSync(resolve(root, 'CLAUDE.md'))).toBe(false)
  })

  it('fixture: two known stacks + one unknown → exactly three CLAUDE.md files with correct content', () => {
    // Two known stacks
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
      'backend/package.json': JSON.stringify({
        dependencies: { express: '*' },
      }),
    })

    // One unknown stack — injected directly so we don't need an exotic manifest
    const detected = detectStack(root)
    const unknownSpec: SupervisorSpec = {
      name: 'exotic-ai-supervisor',
      persona: 'Zara',
      kind: 'specialized',
      scope: 'ml/',
      detectedFrom: ['ml/exotic.json'],
      externalSlugs: [],
      techs: ['exotic'],
    }
    mkdirSync(resolve(root, 'ml'), { recursive: true })

    const allSupervisors = [...detected.supervisors, unknownSpec]
    const result = writePerFolderClaudeMds({ repoRoot: root, supervisors: allSupervisors })

    // Exactly 3 CLAUDE.md files: frontend/, backend/, ml/
    expect(result.written).toHaveLength(3)
    expect(result.written.sort()).toEqual(
      ['backend/CLAUDE.md', 'frontend/CLAUDE.md', 'ml/CLAUDE.md'].sort(),
    )

    const catalogue = loadCatalogue()

    // Known stacks get their catalogue entry
    expect(readFileSync(resolve(root, 'frontend', 'CLAUDE.md'), 'utf8')).toBe(
      lookupCatalogue(catalogue, 'react-supervisor'),
    )
    expect(readFileSync(resolve(root, 'backend', 'CLAUDE.md'), 'utf8')).toBe(
      lookupCatalogue(catalogue, 'node-backend-supervisor'),
    )

    // Unknown stack gets the generic baseline
    expect(readFileSync(resolve(root, 'ml', 'CLAUDE.md'), 'utf8')).toBe(
      lookupCatalogue(catalogue, 'generic'),
    )
  })

  it('is purely offline: no network access (loadCatalogue reads from committed disk files)', () => {
    // This test verifies indirectly: writePerFolderClaudeMds must complete
    // without error in a test environment that has no network access.
    // The catalogue is loaded from committed templates/per-stack/ files.
    make(root, {
      'pkg/package.json': JSON.stringify({
        dependencies: { react: '*' },
      }),
    })

    const detected = detectStack(root)
    // Must not throw (i.e., no network call that could fail)
    expect(() =>
      writePerFolderClaudeMds({ repoRoot: root, supervisors: detected.supervisors }),
    ).not.toThrow()

    expect(existsSync(resolve(root, 'pkg', 'CLAUDE.md'))).toBe(true)
  })
})
