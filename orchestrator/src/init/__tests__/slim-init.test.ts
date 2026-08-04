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
import { writeSlimInit } from '../writer'

const slimInputFor = (root: string) => ({
  repoRoot: root,
})

describe('writeSlimInit', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-slim-init-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the sharded knowledge surface when one is not already present', () => {
    writeSlimInit(slimInputFor(root))

    expect(existsSync(resolve(root, 'docs/knowledge/glossary'))).toBe(true)
    const content = readFileSync(resolve(root, 'docs/knowledge/README.md'), 'utf8')
    expect(content).toContain('glossary/')
    expect(content).toContain('decisions/')
    expect(content).toContain('vision.md')
  })

  it('does not overwrite an existing knowledge README', () => {
    const readme = resolve(root, 'docs/knowledge/README.md')
    const existing = '# Existing knowledge\n'
    mkdirSync(resolve(root, 'docs/knowledge'), { recursive: true })
    writeFileSync(readme, existing, 'utf8')

    writeSlimInit(slimInputFor(root))

    expect(readFileSync(readme, 'utf8')).toBe(existing)
  })

  it('creates the decisions scaffold directory', () => {
    writeSlimInit(slimInputFor(root))

    expect(existsSync(resolve(root, 'docs/knowledge/decisions'))).toBe(true)
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
