import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InitConfigError, loadInitConfig } from '../init-config'

describe('loadInitConfig', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-init-config-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const write = (name: string, body: string): string => {
    const p = resolve(root, name)
    writeFileSync(p, body)
    return p
  }

  it('maps each [[stack]] entry to the right supervisor, scope and techs', () => {
    const cfg = write(
      'mars.init.toml',
      `
[[stack]]
path = "gateway"
tech = "node-backend"

[[stack]]
path = "dashboard"
tech = "react"
`,
    )

    const det = loadInitConfig(cfg, root)

    expect(det.supervisors).toHaveLength(2)
    const gateway = det.supervisors.find((s) => s.scope === 'gateway')
    const dashboard = det.supervisors.find((s) => s.scope === 'dashboard')

    expect(gateway).toMatchObject({
      name: 'node-backend-supervisor',
      persona: 'Nina',
      kind: 'backend',
    })
    expect(gateway?.techs).toEqual(['javascript', 'node', 'node-backend'])
    expect(gateway?.detectedFrom).toEqual(['gateway/mars.init:node-backend'])

    expect(dashboard).toMatchObject({
      name: 'react-supervisor',
      persona: 'Luna',
      kind: 'frontend',
    })
    expect(dashboard?.techs).toEqual(['javascript', 'node', 'react'])

    expect(det.frameworks).toEqual(['node-backend', 'react'])
    expect(det.languages).toEqual(['javascript'])
    expect(det.warnings).toEqual([])
    expect(det.manifests).toEqual([
      {
        dir: 'gateway',
        techs: ['javascript', 'node', 'node-backend'],
        supervisors: ['node-backend-supervisor'],
      },
      {
        dir: 'dashboard',
        techs: ['javascript', 'node', 'react'],
        supervisors: ['react-supervisor'],
      },
    ])
  })

  it('accepts a root-scoped entry ("." path)', () => {
    const cfg = write('c.toml', `[[stack]]\npath = "."\ntech = "go"`)
    const det = loadInitConfig(cfg, root)
    expect(det.supervisors).toHaveLength(1)
    expect(det.supervisors[0]).toMatchObject({
      name: 'go-supervisor',
      scope: '.',
    })
    expect(det.manifests[0]?.dir).toBe('.')
  })

  it('normalises "./sub/" path forms to "sub"', () => {
    const cfg = write('c.toml', `[[stack]]\npath = "./packages/api/"\ntech = "go"`)
    const det = loadInitConfig(cfg, root)
    expect(det.supervisors[0]?.scope).toBe('packages/api')
  })

  it('forces infra supervisors to repo-wide scope regardless of path', () => {
    const cfg = write('c.toml', `[[stack]]\npath = "ops"\ntech = "infra"`)
    const det = loadInitConfig(cfg, root)
    expect(det.supervisors[0]).toMatchObject({
      name: 'infra-supervisor',
      scope: '.',
    })
  })

  it('merges two folders that map to the same supervisor', () => {
    const cfg = write(
      'c.toml',
      `
[[stack]]
path = "web"
tech = "react"

[[stack]]
path = "admin"
tech = "nextjs"
`,
    )
    const det = loadInitConfig(cfg, root)
    // Both map to react-supervisor — one merged spec, two detectedFrom entries.
    expect(det.supervisors).toHaveLength(1)
    expect(det.supervisors[0]?.name).toBe('react-supervisor')
    expect(det.supervisors[0]?.detectedFrom).toEqual([
      'web/mars.init:react',
      'admin/mars.init:nextjs',
    ])
    expect(det.supervisors[0]?.techs).toContain('nextjs')
  })

  it('rejects an unknown tech with a helpful message', () => {
    const cfg = write('c.toml', `[[stack]]\npath = "x"\ntech = "cobol"`)
    expect(() => loadInitConfig(cfg, root)).toThrowError(InitConfigError)
    expect(() => loadInitConfig(cfg, root)).toThrowError(/unknown tech "cobol"/)
  })

  it('rejects a config with no [[stack]] entries', () => {
    const cfg = write('c.toml', `name = "nope"`)
    expect(() => loadInitConfig(cfg, root)).toThrowError(
      /at least one \[\[stack\]\] entry/,
    )
  })

  it('rejects an entry missing path or tech', () => {
    expect(() =>
      loadInitConfig(write('a.toml', `[[stack]]\ntech = "go"`), root),
    ).toThrowError(/requires a non-empty string `path`/)
    expect(() =>
      loadInitConfig(write('b.toml', `[[stack]]\npath = "x"`), root),
    ).toThrowError(/requires a non-empty string `tech`/)
  })

  it('rejects duplicate path+tech entries', () => {
    const cfg = write(
      'c.toml',
      `
[[stack]]
path = "api"
tech = "go"

[[stack]]
path = "api"
tech = "go"
`,
    )
    expect(() => loadInitConfig(cfg, root)).toThrowError(/duplicate \[\[stack\]\]/)
  })

  it('reports a TOML parse error rather than crashing', () => {
    const cfg = write('c.toml', `[[stack]\npath = "x"`)
    expect(() => loadInitConfig(cfg, root)).toThrowError(/TOML parse error/)
  })

  it('reports a missing config file', () => {
    expect(() =>
      loadInitConfig(resolve(root, 'does-not-exist.toml'), root),
    ).toThrowError(/cannot read file/)
  })
})
