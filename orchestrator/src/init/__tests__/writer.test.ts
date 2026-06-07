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
import { detectStack, type SupervisorSpec } from '../detect-stack'
import { renderSupervisor, minimalRenderInput } from '../render'
import {
  writeSupervisors,
  type RenderedSupervisor,
} from '../writer'

const make = (root: string, files: Record<string, string>): void => {
  for (const [rel, body] of Object.entries(files)) {
    const path = resolve(root, rel)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
}

const writeCtx = (repoRoot: string) => ({
  repoRoot,
  supervisorsDir: resolve(repoRoot, '.mars', 'supervisors'),
  supervisorsManifest: resolve(repoRoot, '.mars', 'supervisors', 'manifest.json'),
})

const emptyStack = {
  languages: [],
  frameworks: [],
  infra: [],
  mobile: [],
  specialized: [],
}

const renderForSpec = (spec: SupervisorSpec): RenderedSupervisor => ({
  spec,
  content: renderSupervisor(minimalRenderInput(spec)),
  outcome: 'miss' as const,
  triedSlugs: [],
  externalSource: null,
})

describe('mars init AGENTS.md writer', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-init-writer-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes <scope>/AGENTS.md with sentinel-wrapped content from a sub-package', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({
        name: 'fe',
        dependencies: { react: '*', 'react-dom': '*' },
      }),
    })

    const detected = detectStack(root)
    const reactSpec = detected.supervisors.find((s) => s.name === 'react-supervisor')
    expect(reactSpec).toBeDefined()
    expect(reactSpec?.scope).toBe('frontend/')

    const result = writeSupervisors(
      writeCtx(root),
      emptyStack,
      detected.supervisors.map(renderForSpec),
    )

    const target = resolve(root, 'frontend', 'AGENTS.md')
    expect(existsSync(target)).toBe(true)
    const content = readFileSync(target, 'utf8')
    expect(content).toContain('<!-- mars-init:supervisor=react-supervisor:scope=frontend/ -->')
    expect(content).toContain('<!-- /mars-init:supervisor=react-supervisor:scope=frontend/ -->')
    expect(content).toContain('react-supervisor')

    const manifest = JSON.parse(
      readFileSync(writeCtx(root).supervisorsManifest, 'utf8'),
    ) as { supervisors: Array<{ name: string; scope: string }> }
    const entry = manifest.supervisors.find((s) => s.name === 'react-supervisor')
    expect(entry?.scope).toBe('frontend/')
    expect(result.outcomes.some((o) => o.name === 'react-supervisor')).toBe(true)
  })

  it('is idempotent: re-running does not duplicate the sentinel block', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
    })

    const detected = detectStack(root)
    const rendered = detected.supervisors.map(renderForSpec)
    writeSupervisors(writeCtx(root), emptyStack, rendered)
    const first = readFileSync(resolve(root, 'frontend', 'AGENTS.md'), 'utf8')

    writeSupervisors(writeCtx(root), emptyStack, rendered)
    const second = readFileSync(resolve(root, 'frontend', 'AGENTS.md'), 'utf8')

    expect(second).toBe(first)
    const opens = (second.match(/<!-- mars-init:supervisor=react-supervisor:scope=frontend\/ -->/g) ?? []).length
    expect(opens).toBe(1)
  })

  it('removes a stale sentinel block when its stack disappears', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
    })

    const first = detectStack(root)
    writeSupervisors(writeCtx(root), emptyStack, first.supervisors.map(renderForSpec))

    const target = resolve(root, 'frontend', 'AGENTS.md')
    expect(existsSync(target)).toBe(true)

    rmSync(resolve(root, 'frontend', 'package.json'))

    const second = detectStack(root)
    writeSupervisors(writeCtx(root), emptyStack, second.supervisors.map(renderForSpec))

    expect(existsSync(target)).toBe(false)
  })

  it('preserves user content around a sentinel block when only the block changes', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
      'frontend/AGENTS.md': '# Custom user notes\n\nKeep these around.\n',
    })

    const detected = detectStack(root)
    writeSupervisors(writeCtx(root), emptyStack, detected.supervisors.map(renderForSpec))

    const target = resolve(root, 'frontend', 'AGENTS.md')
    const content = readFileSync(target, 'utf8')
    expect(content).toContain('# Custom user notes')
    expect(content).toContain('Keep these around.')
    expect(content).toContain('<!-- mars-init:supervisor=react-supervisor:scope=frontend/ -->')
  })

  it('writes/updates root AGENTS.md without ever touching CLAUDE.md', () => {
    make(root, {
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { express: '*' },
      }),
      'CLAUDE.md': 'CUSTOM CLAUDE FILE\n',
    })

    const detected = detectStack(root)
    const nodeSpec = detected.supervisors.find((s) => s.name === 'node-backend-supervisor')
    expect(nodeSpec?.scope).toBe('.')

    writeSupervisors(writeCtx(root), emptyStack, detected.supervisors.map(renderForSpec))

    const claude = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')
    expect(claude).toBe('CUSTOM CLAUDE FILE\n')

    const rootAgents = readFileSync(resolve(root, 'AGENTS.md'), 'utf8')
    expect(rootAgents).toContain('<!-- mars-init:supervisor=node-backend-supervisor:scope=. -->')
  })

  it('does not write any .md files to .mars/supervisors/ — only manifest.json', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
    })

    const detected = detectStack(root)
    writeSupervisors(writeCtx(root), emptyStack, detected.supervisors.map(renderForSpec))

    const supervisorsDir = resolve(root, '.mars', 'supervisors')
    const entries = readdirSync(supervisorsDir).sort()
    expect(entries).toEqual(['manifest.json'])
  })

  it('reports removed paths in the result and updates the manifest', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
      'frontend/AGENTS.md': '# Custom\n\nKeep me.\n',
    })
    const first = detectStack(root)
    writeSupervisors(writeCtx(root), emptyStack, first.supervisors.map(renderForSpec))

    rmSync(resolve(root, 'frontend', 'package.json'))
    const second = detectStack(root)
    const result = writeSupervisors(
      writeCtx(root),
      emptyStack,
      second.supervisors.map(renderForSpec),
    )
    expect(result.removed.some((p) => p.endsWith('frontend/AGENTS.md'))).toBe(true)

    const target = resolve(root, 'frontend', 'AGENTS.md')
    expect(existsSync(target)).toBe(true)
    const content = readFileSync(target, 'utf8')
    expect(content).toContain('# Custom')
    expect(content).not.toContain('mars-init:supervisor=react-supervisor')
  })
})
