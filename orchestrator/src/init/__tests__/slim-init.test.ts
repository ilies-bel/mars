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
import { writeSlimInit, type VerifyStepEntry } from '../writer'

const SAMPLE_STEPS: VerifyStepEntry[] = [
  { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
  { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
]

const slimInputFor = (root: string) => ({
  repoRoot: root,
  verifyConfigPath: resolve(root, '.mars', 'verify.json'),
  contextPath: resolve(root, 'CONTEXT.md'),
  adrDir: resolve(root, 'docs', 'adr'),
  verifySteps: SAMPLE_STEPS,
  now: () => '2026-05-10T00:00:00.000Z',
})

describe('writeSlimInit', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-slim-init-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes a slim .mars/verify.json with version, generatedAt, verifySteps and nothing else', () => {
    writeSlimInit(slimInputFor(root))

    const path = resolve(root, '.mars', 'verify.json')
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['generatedAt', 'verifySteps', 'version'])
    expect(parsed.version).toBe(1)
    expect(parsed.generatedAt).toBe('2026-05-10T00:00:00.000Z')
    expect(parsed.verifySteps).toEqual(SAMPLE_STEPS)
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
