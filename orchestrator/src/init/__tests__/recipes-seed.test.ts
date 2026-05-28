import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { writeRecipesSeed } from '../recipes-seed'
import {
  listBuiltInRecipeFiles,
  loadRecipeCatalog,
  recipesDir,
} from '../../mastra/lib/recipes'

describe('writeRecipesSeed', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(resolve(tmpdir(), 'mars-recipes-seed-'))
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('writes one .md per shipped built-in on a fresh stateDir', () => {
    const built = listBuiltInRecipeFiles()
    expect(built.length).toBe(9)
    const result = writeRecipesSeed(stateDir)
    expect(result.written).toHaveLength(built.length)
    expect(result.skipped).toHaveLength(0)
    const files = readdirSync(result.dir).sort()
    expect(files).toEqual(built.map((b) => `${b.name}.md`).sort())
  })

  it('written files match the shipped contents byte for byte', () => {
    const result = writeRecipesSeed(stateDir)
    for (const entry of listBuiltInRecipeFiles()) {
      const abs = resolve(result.dir, `${entry.name}.md`)
      expect(readFileSync(abs, 'utf8')).toBe(entry.contents)
    }
  })

  it('is idempotent on rerun: skips existing files, writes none', () => {
    writeRecipesSeed(stateDir)
    const second = writeRecipesSeed(stateDir)
    expect(second.written).toHaveLength(0)
    expect(second.skipped).toHaveLength(listBuiltInRecipeFiles().length)
  })

  it('preserves user edits to existing files', () => {
    const dir = recipesDir(stateDir)
    mkdirSync(dir, { recursive: true })
    const customPath = resolve(dir, 'typecheck-fixer.md')
    const customBody =
      `---
name: typecheck-fixer
description: I own this now.
tools: [Bash]
---
# my body
`
    writeFileSync(customPath, customBody, 'utf8')

    const result = writeRecipesSeed(stateDir)
    expect(result.skipped).toContain('typecheck-fixer.md')
    expect(result.written).not.toContain('typecheck-fixer.md')
    expect(readFileSync(customPath, 'utf8')).toBe(customBody)
  })

  it('writes missing files on a partial-existing dir without touching the rest', () => {
    const first = writeRecipesSeed(stateDir)
    expect(first.written.length).toBeGreaterThan(0)
    // Remove one file to simulate a new built-in shipping in a binary upgrade.
    const removed = 'typecheck-fixer.md'
    rmSync(resolve(first.dir, removed))
    const second = writeRecipesSeed(stateDir)
    expect(second.written).toEqual([removed])
  })

  it('seeded files load cleanly through loadRecipeCatalog', async () => {
    writeRecipesSeed(stateDir)
    const warnings: string[] = []
    const cat = await loadRecipeCatalog(stateDir, {
      onWarn: (m) => warnings.push(m),
    })
    // The override directory now mirrors the built-in seed exactly, so
    // every recipe should be the 'override' variant.
    for (const entry of listBuiltInRecipeFiles()) {
      const recipe = cat.get(entry.name)
      expect(recipe).not.toBeNull()
      expect(recipe?.source).toBe('override')
    }
    expect(warnings).toEqual([])
  })
})
