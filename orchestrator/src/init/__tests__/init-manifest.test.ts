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
import { readInitManifest, writeInitManifest } from '../init-manifest'
import { detectStack } from '../detect-stack'
import { writePerFolderClaudeMds } from '../writer'

const make = (root: string, files: Record<string, string>): void => {
  for (const [rel, body] of Object.entries(files)) {
    const path = resolve(root, rel)
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, body, 'utf8')
  }
}

describe('readInitManifest / writeInitManifest', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-init-manifest-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('returns empty array when no manifest file exists', () => {
    const paths = readInitManifest(root)
    expect(paths).toEqual([])
  })

  it('round-trips paths through write → read', () => {
    const paths = ['frontend/CLAUDE.md', 'backend/CLAUDE.md', 'CLAUDE.md']
    writeInitManifest(root, paths)

    expect(readInitManifest(root)).toEqual(paths)
  })

  it('writes a valid JSON file at <marsDir>/init-manifest.json', () => {
    writeInitManifest(root, ['frontend/CLAUDE.md'])

    const raw = JSON.parse(readFileSync(resolve(root, 'init-manifest.json'), 'utf8')) as {
      version: number
      generatedAt: string
      paths: string[]
    }
    expect(raw.version).toBe(1)
    expect(typeof raw.generatedAt).toBe('string')
    expect(raw.paths).toEqual(['frontend/CLAUDE.md'])
  })

  it('accepts a custom clock via the now parameter', () => {
    const ts = '2026-01-15T12:00:00.000Z'
    writeInitManifest(root, ['x/CLAUDE.md'], () => ts)

    const raw = JSON.parse(readFileSync(resolve(root, 'init-manifest.json'), 'utf8')) as {
      generatedAt: string
    }
    expect(raw.generatedAt).toBe(ts)
  })

  it('overwrites a previous manifest on repeated writes', () => {
    writeInitManifest(root, ['frontend/CLAUDE.md'])
    writeInitManifest(root, ['backend/CLAUDE.md', 'tools/CLAUDE.md'])

    expect(readInitManifest(root)).toEqual(['backend/CLAUDE.md', 'tools/CLAUDE.md'])
  })

  it('returns empty array for a malformed manifest JSON', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(resolve(root, 'init-manifest.json'), 'not-json', 'utf8')

    expect(readInitManifest(root)).toEqual([])
  })

  it('creates the marsDir if it does not yet exist', () => {
    const subDir = resolve(root, 'nested', '.mars')
    writeInitManifest(subDir, ['a/CLAUDE.md'])

    expect(existsSync(resolve(subDir, 'init-manifest.json'))).toBe(true)
  })
})

describe('writePerFolderClaudeMds — init-manifest integration', () => {
  let root: string
  let marsDir: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-init-manifest-e2e-'))
    marsDir = resolve(root, '.mars')
    mkdirSync(marsDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes the init manifest after the first run', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({ dependencies: { react: '*' } }),
    })

    const detected = detectStack(root)
    writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: detected.supervisors })

    expect(existsSync(resolve(marsDir, 'init-manifest.json'))).toBe(true)
    const manifest = readInitManifest(marsDir)
    expect(manifest).toContain('frontend/CLAUDE.md')
  })

  it('updates the manifest on re-run to reflect the current set of written paths', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({ dependencies: { react: '*' } }),
    })

    // First run
    const detected1 = detectStack(root)
    writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: detected1.supervisors })
    expect(readInitManifest(marsDir)).toContain('frontend/CLAUDE.md')

    // Second run — same supervisors, manifest should still list frontend/CLAUDE.md
    const detected2 = detectStack(root)
    writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: detected2.supervisors })
    expect(readInitManifest(marsDir)).toContain('frontend/CLAUDE.md')
  })

  it('adds a new subproject to the manifest on the second run', () => {
    make(root, {
      'frontend/package.json': JSON.stringify({ dependencies: { react: '*' } }),
    })

    // First run — only frontend
    const detected1 = detectStack(root)
    writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: detected1.supervisors })
    expect(readInitManifest(marsDir)).not.toContain('api/CLAUDE.md')

    // Add new subproject between runs
    make(root, {
      'api/package.json': JSON.stringify({ dependencies: { express: '*' } }),
    })

    // Second run — both frontend + api detected; api/CLAUDE.md should be new
    const detected2 = detectStack(root)
    writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: detected2.supervisors })

    expect(existsSync(resolve(root, 'api', 'CLAUDE.md'))).toBe(true)
    const manifest = readInitManifest(marsDir)
    expect(manifest).toContain('api/CLAUDE.md')
    expect(manifest).toContain('frontend/CLAUDE.md')
  })

  it('leaves a hand-written CLAUDE.md untouched on re-run', () => {
    make(root, {
      // express triggers node-backend-supervisor in detectStack
      'lib/package.json': JSON.stringify({ dependencies: { express: '*' } }),
    })

    // First run — mars init writes lib/CLAUDE.md
    const detected1 = detectStack(root)
    writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: detected1.supervisors })
    expect(readInitManifest(marsDir)).toContain('lib/CLAUDE.md')

    // User hand-writes tools/CLAUDE.md (no mars init involvement)
    mkdirSync(resolve(root, 'tools'), { recursive: true })
    const handWrittenContent = '# My hand-written CLAUDE.md\n\nDo not overwrite!\n'
    writeFileSync(resolve(root, 'tools', 'CLAUDE.md'), handWrittenContent, 'utf8')

    // tools/ now has a package.json so it becomes a detected supervisor on the next run
    make(root, {
      'tools/package.json': JSON.stringify({ name: 'tools' }),
    })

    // Second run — tools/ is detected but tools/CLAUDE.md is NOT in the manifest
    const detected2 = detectStack(root)
    writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: detected2.supervisors })

    // Hand-written file must be left untouched
    const after = readFileSync(resolve(root, 'tools', 'CLAUDE.md'), 'utf8')
    expect(after).toBe(handWrittenContent)

    // And it must NOT appear in the updated manifest (mars didn't write it)
    expect(readInitManifest(marsDir)).not.toContain('tools/CLAUDE.md')
  })

  it('tracer-bullet: two consecutive init runs with an added subproject — manifest and files are correct', () => {
    // ── Run 1: only frontend ─────────────────────────────────────────────────
    make(root, {
      'frontend/package.json': JSON.stringify({
        dependencies: { react: '*', 'react-dom': '*' },
      }),
    })

    const supervisors1 = detectStack(root).supervisors
    const result1 = writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: supervisors1 })

    expect(result1.written).toEqual(['frontend/CLAUDE.md'])
    expect(existsSync(resolve(root, 'frontend', 'CLAUDE.md'))).toBe(true)
    expect(readInitManifest(marsDir)).toEqual(['frontend/CLAUDE.md'])

    // ── Add a second subproject between runs ──────────────────────────────────
    make(root, {
      'backend/package.json': JSON.stringify({ dependencies: { express: '*' } }),
    })

    // ── Run 2: frontend + backend ─────────────────────────────────────────────
    const supervisors2 = detectStack(root).supervisors
    const result2 = writePerFolderClaudeMds({ repoRoot: root, marsDir, supervisors: supervisors2 })

    // Both CLAUDE.md files must exist on disk
    expect(existsSync(resolve(root, 'frontend', 'CLAUDE.md'))).toBe(true)
    expect(existsSync(resolve(root, 'backend', 'CLAUDE.md'))).toBe(true)

    // result2.written must include both (frontend was re-written as Mars-owned)
    expect(result2.written.sort()).toEqual(['backend/CLAUDE.md', 'frontend/CLAUDE.md'].sort())

    // Manifest must list exactly the two per-folder paths
    expect(readInitManifest(marsDir).sort()).toEqual(
      ['backend/CLAUDE.md', 'frontend/CLAUDE.md'].sort(),
    )
  })
})
