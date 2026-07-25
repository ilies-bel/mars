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
