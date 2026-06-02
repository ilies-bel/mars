import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { writeFailureReasonsSeed } from '../failure-reasons-seed'
import { BUILT_IN_FAILURE_REASONS } from '../../core/failure-reasons/built-in'
import { codeToFilename } from '../../core/lib/failure-reasons'

describe('writeFailureReasonsSeed', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(resolve(tmpdir(), 'mars-fr-seed-'))
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('writes one YAML file per built-in entry on a fresh stateDir', () => {
    const result = writeFailureReasonsSeed(stateDir)
    expect(result.written).toHaveLength(BUILT_IN_FAILURE_REASONS.length)
    expect(result.skipped).toHaveLength(0)
    const files = readdirSync(result.dir).sort()
    const expected = BUILT_IN_FAILURE_REASONS
      .map((e) => codeToFilename(e.code))
      .sort()
    expect(files).toEqual(expected)
  })

  it('written files are valid YAML and round-trip to the built-in entries', () => {
    const result = writeFailureReasonsSeed(stateDir)
    for (const entry of BUILT_IN_FAILURE_REASONS) {
      const abs = resolve(result.dir, codeToFilename(entry.code))
      const raw = readFileSync(abs, 'utf8')
      // Carries the ownership comment.
      expect(raw.startsWith('# Failure-reason catalog entry')).toBe(true)
      const parsed = parseYaml(raw) as Record<string, unknown>
      expect(parsed.code).toBe(entry.code)
      expect(parsed.userMessage).toBe(entry.userMessage)
      expect(parsed.recipe).toBe(entry.recipe)
      expect(Array.isArray(parsed.availableActions)).toBe(true)
      expect((parsed.availableActions as unknown[]).length).toBe(
        entry.availableActions.length,
      )
    }
  })

  it('is idempotent on rerun: skips existing files, writes none', () => {
    writeFailureReasonsSeed(stateDir)
    const second = writeFailureReasonsSeed(stateDir)
    expect(second.written).toHaveLength(0)
    expect(second.skipped).toHaveLength(BUILT_IN_FAILURE_REASONS.length)
  })

  it('preserves user edits to existing files', () => {
    const dir = resolve(stateDir, 'failure-reasons')
    mkdirSync(dir, { recursive: true })
    const customPath = resolve(dir, codeToFilename('verify:test'))
    const customBody = '# I own this now.\ncode: verify:test\nuserMessage: My message.\nrecipe: null\navailableActions:\n  - id: restart\n    label: Restart\n    cliHint: null\n'
    writeFileSync(customPath, customBody, 'utf8')

    const result = writeFailureReasonsSeed(stateDir)
    // verify:test was skipped; everything else written.
    expect(result.skipped).toContain(codeToFilename('verify:test'))
    expect(result.written).not.toContain(codeToFilename('verify:test'))
    expect(readFileSync(customPath, 'utf8')).toBe(customBody)
  })

  it('writes missing files on a partial-existing dir without touching the rest', () => {
    const first = writeFailureReasonsSeed(stateDir)
    expect(first.written.length).toBeGreaterThan(0)
    // Remove one file to simulate a new built-in code added in a binary upgrade.
    const removed = codeToFilename('verify:test')
    rmSync(resolve(first.dir, removed))
    const second = writeFailureReasonsSeed(stateDir)
    expect(second.written).toEqual([removed])
  })
})
