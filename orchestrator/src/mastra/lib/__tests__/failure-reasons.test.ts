import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  codeToFilename,
  failureReasonsDir,
  failureReasonStringToCode,
  filenameToCode,
  loadFailureReasonCatalog,
  renderAvailableActionsMarkdown,
  substituteTaskId,
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

  describe('failureReasonStringToCode', () => {
    it('null → unknown', () => {
      expect(failureReasonStringToCode(null)).toBe('unknown')
    })

    it('typecheck substring → verify:typecheck', () => {
      expect(failureReasonStringToCode('typecheck failed')).toBe(
        'verify:typecheck',
      )
      expect(failureReasonStringToCode('verify:typecheck')).toBe(
        'verify:typecheck',
      )
    })

    it('test substring → verify:test', () => {
      expect(failureReasonStringToCode('test suite failed')).toBe(
        'verify:test',
      )
      expect(failureReasonStringToCode('vitest run failed')).toBe(
        'verify:test',
      )
    })

    it('lint substring → verify:lint', () => {
      expect(failureReasonStringToCode('eslint failed')).toBe('verify:lint')
    })

    it('main-dirty substring → verify:main-dirty', () => {
      expect(failureReasonStringToCode('verify:main-dirty')).toBe(
        'verify:main-dirty',
      )
      expect(failureReasonStringToCode('SOMETHING main-dirty XYZ')).toBe(
        'verify:main-dirty',
      )
    })

    it('legacy preflight/dirty-main strings map to verify:main-dirty (slice K bridge)', () => {
      // Bare legacy signature.
      expect(failureReasonStringToCode('setup:preflight/dirty-main')).toBe(
        'verify:main-dirty',
      )
      // Wrapped legacy form persisted by the retry-budget exhaustion path.
      expect(
        failureReasonStringToCode(
          'retry_budget_exhausted:setup:preflight/dirty-main',
        ),
      ).toBe('verify:main-dirty')
      // Case-insensitive.
      expect(failureReasonStringToCode('SETUP:PREFLIGHT/DIRTY-MAIN')).toBe(
        'verify:main-dirty',
      )
    })

    it('no-edits-made variants → code:no-edits-made', () => {
      expect(failureReasonStringToCode('no-edits-made')).toBe(
        'code:no-edits-made',
      )
      expect(failureReasonStringToCode('no_edits_made')).toBe(
        'code:no-edits-made',
      )
    })

    it('timeout substring → code:timeout', () => {
      expect(failureReasonStringToCode('coder exceeded timeout')).toBe(
        'code:timeout',
      )
    })

    it('over-budget variants → code:over-budget', () => {
      expect(failureReasonStringToCode('over-budget')).toBe('code:over-budget')
      expect(failureReasonStringToCode('over_budget')).toBe('code:over-budget')
    })

    it('vcs-supervisor variants → merge:vcs-supervisor-aborted', () => {
      expect(failureReasonStringToCode('vcs-supervisor-aborted')).toBe(
        'merge:vcs-supervisor-aborted',
      )
      expect(failureReasonStringToCode('vega-aborted')).toBe(
        'merge:vcs-supervisor-aborted',
      )
    })

    it('unmatched strings → unknown', () => {
      expect(failureReasonStringToCode('some random unknown garbage')).toBe(
        'unknown',
      )
      expect(failureReasonStringToCode('retry_budget_exhausted_at_unblock')).toBe(
        'unknown',
      )
    })

    it('is case-insensitive', () => {
      expect(failureReasonStringToCode('TYPECHECK FAILED')).toBe(
        'verify:typecheck',
      )
    })
  })

  describe('substituteTaskId', () => {
    it('replaces every <id> occurrence with the task id', () => {
      expect(substituteTaskId('mars restart <id>', 'mars-abc123')).toBe(
        'mars restart mars-abc123',
      )
      expect(substituteTaskId('<id> blocked by <id>', 'mars-xyz')).toBe(
        'mars-xyz blocked by mars-xyz',
      )
    })

    it('leaves strings without <id> untouched', () => {
      expect(substituteTaskId('inspect transcript', 'mars-abc')).toBe(
        'inspect transcript',
      )
    })
  })

  describe('renderAvailableActionsMarkdown', () => {
    it('renders cliHint actions as backticked code with task-id substitution', () => {
      const actions = [
        {
          id: 'restart',
          label: 'Restart from scratch',
          cliHint: 'mars restart <id>',
        },
        {
          id: 'purge',
          label: 'Drop permanently',
          cliHint: 'mars purge <id>',
        },
      ]
      const out = renderAvailableActionsMarkdown(actions, 'mars-abc123')
      expect(out).toBe(
        '- Restart from scratch: `mars restart mars-abc123`\n' +
          '- Drop permanently: `mars purge mars-abc123`',
      )
    })

    it('renders null cliHint actions without a code segment', () => {
      const actions = [
        { id: 'dismiss', label: 'Dismiss', cliHint: null },
      ]
      const out = renderAvailableActionsMarkdown(actions, 'mars-abc')
      expect(out).toBe('- Dismiss')
    })

    it('mixes null and string cliHints correctly', () => {
      const actions = [
        {
          id: 'restart',
          label: 'Restart',
          cliHint: 'mars restart <id>',
        },
        { id: 'dismiss', label: 'Dismiss', cliHint: null },
      ]
      const out = renderAvailableActionsMarkdown(actions, 't-1')
      expect(out).toBe(
        '- Restart: `mars restart t-1`\n- Dismiss',
      )
    })
  })
})
