import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectStack } from '../detect-stack'

const make = (root: string, files: Record<string, string>): void => {
  for (const [rel, body] of Object.entries(files)) {
    const path = resolve(root, rel)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
}

describe('detectStack (recursive)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-detect-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('detects techs across sibling subprojects in a monorepo', () => {
    make(root, {
      'orchestrator/package.json': JSON.stringify({
        name: 'orch',
        dependencies: { '@mastra/core': '*', tsx: '*' },
        devDependencies: { typescript: '*' },
      }),
      'orchestrator/tsconfig.json': '{}',
      'ui/package.json': JSON.stringify({
        name: 'ui',
        dependencies: { react: '*', 'react-dom': '*' },
        devDependencies: { vite: '*', tailwindcss: '*' },
      }),
      'framework/package.json': JSON.stringify({
        name: 'fw',
        devDependencies: { 'bun-types': '*' },
      }),
    })

    const detected = detectStack(root)
    expect(detected.languages).toContain('javascript')
    expect(detected.languages).toContain('typescript')
    expect(detected.frameworks).toContain('react')

    const allTechs = new Set(detected.manifests.flatMap((m) => m.techs))
    for (const t of [
      'typescript',
      'node',
      'mastra',
      'react',
      'vite',
      'tailwind',
      'bun',
    ]) {
      expect(allTechs.has(t)).toBe(true)
    }
  })

  it('emits one supervisor entry across siblings sharing a tech', () => {
    make(root, {
      'a/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
      'b/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
    })

    const detected = detectStack(root)
    const reactSupervisors = detected.supervisors.filter(
      (s) => s.name === 'react-supervisor',
    )
    expect(reactSupervisors).toHaveLength(1)
    // sources from both manifests should be tracked in detectedFrom
    expect(reactSupervisors[0]?.detectedFrom.length).toBeGreaterThanOrEqual(2)
  })

  it('returns an empty stack and empty manifests for an empty repo', () => {
    const detected = detectStack(root)
    expect(detected.languages).toEqual([])
    expect(detected.frameworks).toEqual([])
    expect(detected.supervisors).toEqual([])
    expect(detected.manifests).toEqual([])
  })

  it('still detects root-level infra (Dockerfile, github-actions) without root manifest', () => {
    make(root, {
      Dockerfile: 'FROM node\n',
      '.github/workflows/ci.yml': 'name: ci\n',
      'app/package.json': '{}',
    })

    const detected = detectStack(root)
    expect(detected.infra).toContain('docker')
    expect(detected.infra).toContain('github-actions')
    expect(detected.supervisors.some((s) => s.name === 'infra-supervisor')).toBe(
      true,
    )
  })

  it('invokes onManifest for each manifest discovered', () => {
    make(root, {
      'a/package.json': '{}',
      'b/package.json': '{}',
    })
    const seen: string[] = []
    detectStack(root, { onManifest: (m) => seen.push(m.dir) })
    expect(seen.sort()).toEqual(['a', 'b'])
  })

  it('records the supervisors each manifest contributed, deduped, across a polyrepo fixture with two React manifests', () => {
    const fixture = resolve(
      __dirname,
      '..',
      '..',
      '..',
      'test',
      'fixtures',
      'polyrepo-react',
    )

    const detected = detectStack(fixture)

    const byDir = new Map(detected.manifests.map((m) => [m.dir, m]))
    expect(byDir.get('web')?.supervisors).toEqual(['react-supervisor'])
    expect(byDir.get('admin')?.supervisors).toEqual(['react-supervisor'])

    const reactSupervisors = detected.supervisors.filter(
      (s) => s.name === 'react-supervisor',
    )
    expect(reactSupervisors).toHaveLength(1)
  })

  // NOTE: the PRD's manual-verification example ('./ -> ...' plus './ui -> ...')
  // describes a root manifest with a *nested* subproject manifest. That layout
  // is a hard NestedTechError under the walk-manifests layout contract
  // (tech-bearing folders must be siblings, never nested). The supported
  // multi-scope shape is sibling subprojects, so this fixture asserts the
  // per-supervisor tech lists across two manifests at distinct scopes.
  it('carries a sorted, deduped, flat per-supervisor tech list across two subproject manifests', () => {
    make(root, {
      'api/package.json': JSON.stringify({
        name: 'api',
        dependencies: { express: '*' },
      }),
      'ui/package.json': JSON.stringify({
        name: 'ui',
        dependencies: { react: '*', 'react-dom': '*' },
        devDependencies: { vite: '*' },
      }),
    })

    const detected = detectStack(root)

    const node = detected.supervisors.find(
      (s) => s.name === 'node-backend-supervisor',
    )
    const react = detected.supervisors.find(
      (s) => s.name === 'react-supervisor',
    )

    expect(node?.techs).toEqual(['javascript', 'node', 'node-backend'])
    expect(react?.techs).toEqual(['javascript', 'node', 'react', 'vite'])

    for (const spec of detected.supervisors) {
      // flat: every entry is a plain string, no nested groupings
      expect(spec.techs.every((t) => typeof t === 'string')).toBe(true)
      // sorted alphabetically
      expect([...spec.techs].sort()).toEqual(spec.techs)
      // deduplicated
      expect(new Set(spec.techs).size).toBe(spec.techs.length)
    }
  })

  it('resolves overlapping detections silently to the winning techs only', () => {
    make(root, {
      'a/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
      'b/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*', vite: '*' },
      }),
    })

    const detected = detectStack(root)
    const reactSupervisors = detected.supervisors.filter(
      (s) => s.name === 'react-supervisor',
    )
    expect(reactSupervisors).toHaveLength(1)
    // The first (winning) detection's techs are kept; the losing
    // detection's extra 'vite' is silently dropped, not merged.
    expect(reactSupervisors[0]?.techs).toEqual(['javascript', 'node', 'react'])
  })

  it('skips manifests under ignored directories', () => {
    make(root, {
      'node_modules/foo/package.json': '{"name":"x"}',
      '.mars/foo/package.json': '{}',
      'dist/foo/package.json': '{}',
      'real/package.json': JSON.stringify({ dependencies: { react: '*' } }),
    })
    const detected = detectStack(root)
    expect(detected.manifests).toHaveLength(1)
    expect(detected.manifests[0]?.dir).toBe('real')
  })
})
