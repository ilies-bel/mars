import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_DEPTH,
  NestedTechError,
  WalkAccessError,
  walkManifests,
} from '../walk-manifests'

const make = (root: string, files: Record<string, string>): void => {
  for (const [rel, body] of Object.entries(files)) {
    const path = resolve(root, rel)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
}

describe('walkManifests', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-walk-'))
  })

  afterEach(() => {
    try {
      // restore permission so cleanup works
      chmodSync(root, 0o755)
    } catch {
      // ignore
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('discovers manifests in nested subdirectories', () => {
    make(root, {
      'services/api/package.json': '{"name":"api"}',
      'services/worker/package.json': '{"name":"worker"}',
      'web/package.json': '{"name":"web"}',
    })

    const result = walkManifests(root)
    const dirs = result.manifests.map((m) => m.dir).sort()
    expect(dirs).toEqual([
      resolve(root, 'services/api'),
      resolve(root, 'services/worker'),
      resolve(root, 'web'),
    ])
  })

  it('skips hardcoded ignore directories', () => {
    make(root, {
      'node_modules/foo/package.json': '{}',
      '.git/config': '',
      '.mars/cache/x/package.json': '{}',
      '.worktrees/abc/package.json': '{}',
      'dist/package.json': '{}',
      'build/package.json': '{}',
      '.next/package.json': '{}',
      'target/package.json': '{}',
      'out/package.json': '{}',
    })

    const result = walkManifests(root)
    expect(result.manifests).toHaveLength(0)
  })

  it('rejects nested tech-bearing manifests', () => {
    make(root, {
      'frontend/package.json': '{"name":"f"}',
      'frontend/admin/package.json': '{"name":"a"}',
    })

    expect(() => walkManifests(root)).toThrow(NestedTechError)
  })

  it('honors .gitignore at repo root', () => {
    make(root, {
      '.gitignore': 'vendor/\n',
      'vendor/lib/package.json': '{}',
      'src/package.json': '{}',
    })

    const result = walkManifests(root)
    const dirs = result.manifests.map((m) => m.dir)
    expect(dirs).toEqual([resolve(root, 'src')])
  })

  it('honors a nested .gitignore', () => {
    make(root, {
      'a/.gitignore': 'vendor/\n',
      'a/vendor/package.json': '{}',
      'a/src/package.json': '{}',
    })

    const result = walkManifests(root)
    const dirs = result.manifests.map((m) => m.dir)
    expect(dirs).toEqual([resolve(root, 'a/src')])
  })

  it('skips git submodule paths', () => {
    make(root, {
      '.gitmodules':
        '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/x.git\n',
      'vendor/lib/package.json': '{}',
      'app/package.json': '{}',
    })

    const result = walkManifests(root)
    const dirs = result.manifests.map((m) => m.dir)
    expect(dirs).toEqual([resolve(root, 'app')])
  })

  it('does not recurse below max depth', () => {
    const depth = MAX_DEPTH + 1
    const segments = Array.from({ length: depth }, (_, i) => `d${i}`)
    const deepRel = segments.join('/') + '/package.json'
    make(root, { [deepRel]: '{}' })

    const result = walkManifests(root)
    expect(result.manifests).toHaveLength(0)
    expect(result.warnings.some((w) => w.kind === 'depth-cap')).toBe(true)
  })

  it('detects manifests at exactly max depth', () => {
    const segments = Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`)
    const deepRel = segments.join('/') + '/package.json'
    make(root, { [deepRel]: '{}' })

    const result = walkManifests(root)
    expect(result.manifests).toHaveLength(1)
  })

  it('emits empty result for an empty repo', () => {
    const result = walkManifests(root)
    expect(result.manifests).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('throws WalkAccessError for unreadable directory', () => {
    if (platform() === 'win32') return
    if (process.getuid && process.getuid() === 0) return // root bypasses chmod

    const blocked = resolve(root, 'blocked')
    mkdirSync(blocked)
    chmodSync(blocked, 0o000)
    try {
      expect(() => walkManifests(root)).toThrow(WalkAccessError)
    } finally {
      chmodSync(blocked, 0o755)
    }
  })

  it('throws WalkAccessError for broken symlink', () => {
    if (platform() === 'win32') return
    symlinkSync(resolve(root, 'does-not-exist'), resolve(root, 'broken'))
    expect(() => walkManifests(root)).toThrow(WalkAccessError)
  })
})
