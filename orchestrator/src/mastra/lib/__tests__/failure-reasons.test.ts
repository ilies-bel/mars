import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  codeToFilename,
  failureReasonsDir,
  filenameToCode,
  loadFailureReasonCatalog,
} from '../failure-reasons'
import { BUILT_IN_FAILURE_REASONS } from '../../failure-reasons/built-in'

const setupStateDir = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-failure-reasons-'))
  return dir
}

describe('failure-reasons catalog', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = setupStateDir()
  })

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  describe('built-in seed', () => {
    it('ships an `unknown` fallback entry', () => {
      const codes = BUILT_IN_FAILURE_REASONS.map((e) => e.code)
      expect(codes).toContain('unknown')
    })

    it('every built-in entry has at least one action and a non-empty message', () => {
      for (const entry of BUILT_IN_FAILURE_REASONS) {
        expect(entry.userMessage.length).toBeGreaterThan(0)
        expect(entry.availableActions.length).toBeGreaterThan(0)
      }
    })

    it('every built-in entry has restart + purge + dismiss actions', () => {
      for (const entry of BUILT_IN_FAILURE_REASONS) {
        const ids = entry.availableActions.map((a) => a.id)
        expect(ids).toContain('restart')
        expect(ids).toContain('purge')
        expect(ids).toContain('dismiss')
      }
    })

    it('only `unknown` has the `investigate` action', () => {
      for (const entry of BUILT_IN_FAILURE_REASONS) {
        const ids = entry.availableActions.map((a) => a.id)
        if (entry.code === 'unknown') {
          expect(ids).toContain('investigate')
        } else {
          expect(ids).not.toContain('investigate')
        }
      }
    })

    it('codes never collide', () => {
      const codes = BUILT_IN_FAILURE_REASONS.map((e) => e.code)
      expect(new Set(codes).size).toBe(codes.length)
    })
  })

  describe('loadFailureReasonCatalog', () => {
    it('returns the built-in seed when no override directory exists', async () => {
      const cat = await loadFailureReasonCatalog(stateDir)
      const codes = cat.list().map((e) => e.code).sort()
      const builtInCodes = BUILT_IN_FAILURE_REASONS.map((e) => e.code).sort()
      expect(codes).toEqual(builtInCodes)
    })

    it('returns the built-in seed when the override directory is empty', async () => {
      mkdirSync(failureReasonsDir(stateDir), { recursive: true })
      const cat = await loadFailureReasonCatalog(stateDir)
      expect(cat.list()).toHaveLength(BUILT_IN_FAILURE_REASONS.length)
    })

    it('replaces a built-in entry wholesale when a file matches its code', async () => {
      const dir = failureReasonsDir(stateDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        resolve(dir, codeToFilename('verify:test')),
        `code: verify:test\nuserMessage: Custom message.\nrecipe: custom-recipe\navailableActions:\n  - id: restart\n    label: Try again\n    cliHint: mars restart <id>\n`,
        'utf8',
      )
      const cat = await loadFailureReasonCatalog(stateDir)
      const entry = cat.get('verify:test')
      expect(entry.userMessage).toBe('Custom message.')
      expect(entry.recipe).toBe('custom-recipe')
      expect(entry.availableActions).toHaveLength(1)
      expect(entry.availableActions[0]?.label).toBe('Try again')
    })

    it('adds a new code when the file introduces one not in the built-ins', async () => {
      const dir = failureReasonsDir(stateDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        resolve(dir, codeToFilename('verify:custom')),
        `code: verify:custom\nuserMessage: A new failure mode.\nrecipe: null\navailableActions:\n  - id: restart\n    label: Restart\n    cliHint: null\n`,
        'utf8',
      )
      const cat = await loadFailureReasonCatalog(stateDir)
      const codes = cat.list().map((e) => e.code)
      expect(codes).toContain('verify:custom')
      // Plus all built-ins still present.
      for (const builtin of BUILT_IN_FAILURE_REASONS) {
        expect(codes).toContain(builtin.code)
      }
    })

    it('skips malformed YAML and still loads the rest', async () => {
      const dir = failureReasonsDir(stateDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        resolve(dir, codeToFilename('verify:test')),
        `code: verify:test\nuserMessage: Customised.\nrecipe: null\navailableActions:\n  - id: restart\n    label: Restart\n    cliHint: null\n`,
        'utf8',
      )
      // Malformed file: invalid YAML structure (unbalanced).
      writeFileSync(
        resolve(dir, 'broken.yaml'),
        ': : : not valid yaml\n  - [\n',
        'utf8',
      )
      // Schema-rejected file: missing required `userMessage` field.
      writeFileSync(
        resolve(dir, codeToFilename('verify:typecheck')),
        `code: verify:typecheck\nrecipe: null\navailableActions:\n  - id: restart\n    label: Restart\n    cliHint: null\n`,
        'utf8',
      )
      const warnings: string[] = []
      const cat = await loadFailureReasonCatalog(stateDir, {
        onWarn: (m) => warnings.push(m),
      })
      // verify:test override applied
      expect(cat.get('verify:test').userMessage).toBe('Customised.')
      // verify:typecheck built-in retained (file was rejected)
      expect(cat.get('verify:typecheck').userMessage).toBe(
        'Type checks failed during verification.',
      )
      // Two warnings: one for the YAML parse failure, one for the schema rejection.
      expect(warnings.length).toBeGreaterThanOrEqual(2)
    })

    it('get(undefined) returns the unknown fallback', async () => {
      const cat = await loadFailureReasonCatalog(stateDir)
      expect(cat.get(undefined).code).toBe('unknown')
    })

    it('get(unrecognised-code) returns the unknown fallback', async () => {
      const cat = await loadFailureReasonCatalog(stateDir)
      expect(cat.get('not-a-real-code').code).toBe('unknown')
    })

    it('treats codes case-sensitively', async () => {
      const cat = await loadFailureReasonCatalog(stateDir)
      // Built-in is lowercase `verify:test`; uppercase should miss and fall
      // back to `unknown`.
      expect(cat.get('VERIFY:TEST').code).toBe('unknown')
      expect(cat.get('verify:test').code).toBe('verify:test')
    })
  })

  describe('codeToFilename / filenameToCode', () => {
    it('encodes slashes as `--`', () => {
      expect(codeToFilename('foo/bar')).toBe('foo--bar.yaml')
      expect(codeToFilename('verify:main-dirty')).toBe('verify:main-dirty.yaml')
    })

    it('round-trips for codes without slashes', () => {
      expect(filenameToCode('verify:typecheck.yaml')).toBe('verify:typecheck')
    })

    it('round-trips for codes with slashes', () => {
      expect(filenameToCode('foo--bar.yaml')).toBe('foo/bar')
    })
  })
})
