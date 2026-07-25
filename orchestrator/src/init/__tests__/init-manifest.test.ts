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
