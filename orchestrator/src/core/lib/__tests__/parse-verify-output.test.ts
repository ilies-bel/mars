import { describe, it, expect } from 'vitest'
import {
  parseVerifyOutput,
  verifyFailureLine,
  type ParsedVerifyOutput,
} from '../parse-verify-output.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal gate section header. */
const header = (
  name: string,
  result: 'pass' | 'fail',
  opts: { tier?: string; durationMs?: number; exitCode?: number | null } = {},
): string => {
  const tier = opts.tier !== undefined ? ` [${opts.tier}]` : ' [task]'
  const dur = opts.durationMs !== undefined ? ` ${opts.durationMs}ms` : ''
  const exit =
    opts.exitCode !== undefined
      ? ` exit=${opts.exitCode === null ? 'killed' : opts.exitCode}`
      : ''
  return `=== ${name} (${result})${tier}${dur}${exit} ===`
}

// ---------------------------------------------------------------------------
// Single gate – passing
// ---------------------------------------------------------------------------

describe('parseVerifyOutput – single passing gate', () => {
  const raw = [header('knip', 'pass', { durationMs: 2589, exitCode: 0 }), '$ npx knip', ''].join(
    '\n',
  )

  it('produces one section with passed=true', () => {
    const r = parseVerifyOutput(raw)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].name).toBe('knip')
    expect(r.sections[0].passed).toBe(true)
  })

  it('failingSections is empty', () => {
    const r = parseVerifyOutput(raw)
    expect(r.failingSections).toHaveLength(0)
  })

  it('gateOutcomes is null (no gate outcomes block)', () => {
    const r = parseVerifyOutput(raw)
    expect(r.gateOutcomes).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Single gate – failing with output
// ---------------------------------------------------------------------------

describe('parseVerifyOutput – single failing gate', () => {
  const assertionLine = '× matches DERIVED_KINDS in action-queue-kinds.ts exactly'
  const raw = [
    header('test', 'fail', { tier: 'task', durationMs: 80001, exitCode: 1 }),
    '$ npx vitest run src/foo.test.ts',
    assertionLine,
    "AssertionError: expected [ 'baseline-broken' ] to deeply equal [ 'baseline-broken', 'new-kind' ]",
    '',
  ].join('\n')

  it('produces one failing section', () => {
    const r = parseVerifyOutput(raw)
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].name).toBe('test')
    expect(r.sections[0].passed).toBe(false)
  })

  it('failingSections contains the test gate', () => {
    const r = parseVerifyOutput(raw)
    expect(r.failingSections).toHaveLength(1)
    expect(r.failingSections[0].name).toBe('test')
  })

  it('section output includes the assertion text', () => {
    const r = parseVerifyOutput(raw)
    expect(r.failingSections[0].output).toContain(assertionLine)
    expect(r.failingSections[0].output).toContain('AssertionError')
  })
})

// ---------------------------------------------------------------------------
// Multi-gate: mixed pass/fail with gate outcomes block
// ---------------------------------------------------------------------------

const MULTI_GATE_OUTCOMES = [
  { name: 'knip', tier: 'task', passed: true, exitCode: 0, duration: 2589 },
  { name: 'test', tier: 'task', passed: false, exitCode: 1, duration: 80001 },
]

const buildMultiGate = (): string => {
  const sections = [
    [
      header('knip', 'pass', { tier: 'task', durationMs: 2589, exitCode: 0 }),
      '$ npx knip',
      '0 issues found',
    ].join('\n'),

    [
      header('test', 'fail', { tier: 'task', durationMs: 80001, exitCode: 1 }),
      '$ npx vitest run src/foo.test.ts',
      '× matches DERIVED_KINDS exactly',
      'AssertionError: expected [ A ] to deeply equal [ B ]',
    ].join('\n'),
  ].join('\n\n')

  const diag = [
    '=== gate failure diagnostics ===',
    '--- diagnostics: test ---',
    'cmd: npx vitest run src/foo.test.ts',
    'cwd: /repo/orchestrator',
    'exitCode: 1',
    'stdout:',
    '× matches DERIVED_KINDS exactly',
  ].join('\n')

  const outcomes = `=== gate outcomes ===\n${JSON.stringify(MULTI_GATE_OUTCOMES, null, 2)}`

  return [sections, diag, outcomes].join('\n\n')
}

describe('parseVerifyOutput – multi-gate mixed pass/fail', () => {
  let r: ParsedVerifyOutput

  it('sets up the fixture without throwing', () => {
    r = parseVerifyOutput(buildMultiGate())
  })

  it('finds two gate sections', () => {
    r = parseVerifyOutput(buildMultiGate())
    expect(r.sections).toHaveLength(2)
  })

  it('identifies the failing gate', () => {
    r = parseVerifyOutput(buildMultiGate())
    expect(r.failingSections).toHaveLength(1)
    expect(r.failingSections[0].name).toBe('test')
  })

  it('parses the gate outcomes JSON block', () => {
    r = parseVerifyOutput(buildMultiGate())
    expect(r.gateOutcomes).not.toBeNull()
    expect(r.gateOutcomes).toHaveLength(2)
    expect(r.gateOutcomes![0].name).toBe('knip')
    expect(r.gateOutcomes![0].passed).toBe(true)
    expect(r.gateOutcomes![1].name).toBe('test')
    expect(r.gateOutcomes![1].passed).toBe(false)
  })

  it('does NOT include the diagnostics block content in any gate section', () => {
    r = parseVerifyOutput(buildMultiGate())
    for (const s of r.sections) {
      expect(s.output).not.toContain('--- diagnostics:')
    }
  })
})

// ---------------------------------------------------------------------------
// Empty / edge cases
// ---------------------------------------------------------------------------

describe('parseVerifyOutput – edge cases', () => {
  it('returns empty sections for an empty string', () => {
    const r = parseVerifyOutput('')
    expect(r.sections).toHaveLength(0)
    expect(r.failingSections).toHaveLength(0)
    expect(r.gateOutcomes).toBeNull()
  })

  it('handles truncated output (gate outcomes block cut off)', () => {
    const raw = [
      header('test', 'fail', { tier: 'task', durationMs: 1000, exitCode: 1 }),
      '× assertion failed',
      // No gate outcomes block — simulates RTK truncation
    ].join('\n')
    const r = parseVerifyOutput(raw)
    expect(r.sections).toHaveLength(1)
    expect(r.gateOutcomes).toBeNull()
  })

  it('handles gate names with colons (e.g. typecheck:orchestrator)', () => {
    const raw = [
      header('typecheck:orchestrator', 'fail', { tier: 'task', durationMs: 3000, exitCode: 1 }),
      'error TS2345: bad type',
    ].join('\n')
    const r = parseVerifyOutput(raw)
    expect(r.sections[0].name).toBe('typecheck:orchestrator')
  })

  it('handles a passing-only output gracefully', () => {
    const raw = [
      header('knip', 'pass', { tier: 'task', durationMs: 100, exitCode: 0 }),
      'no issues',
      '',
      `=== gate outcomes ===`,
      JSON.stringify([{ name: 'knip', tier: 'task', passed: true, exitCode: 0, duration: 100 }]),
    ].join('\n')
    const r = parseVerifyOutput(raw)
    expect(r.failingSections).toHaveLength(0)
    expect(r.gateOutcomes).toHaveLength(1)
    expect(r.gateOutcomes![0].passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// verifyFailureLine
// ---------------------------------------------------------------------------

describe('verifyFailureLine', () => {
  it('returns null when no gates failed', () => {
    const r = parseVerifyOutput(
      [
        header('knip', 'pass', { tier: 'task', durationMs: 100, exitCode: 0 }),
        'no issues',
        `=== gate outcomes ===`,
        JSON.stringify([{ name: 'knip', tier: 'task', passed: true, exitCode: 0, duration: 100 }]),
      ].join('\n'),
    )
    expect(verifyFailureLine(r)).toBeNull()
  })

  it('names the failing gate when one gate fails', () => {
    const r = parseVerifyOutput(
      [
        header('test', 'fail', { tier: 'task', durationMs: 5000, exitCode: 1 }),
        '× some test',
        `=== gate outcomes ===`,
        JSON.stringify([{ name: 'test', tier: 'task', passed: false, exitCode: 1, duration: 5000 }]),
      ].join('\n'),
    )
    expect(verifyFailureLine(r)).toBe('test failed (exit 1)')
  })

  it('lists multiple failing gates', () => {
    const r = parseVerifyOutput(
      [
        header('knip', 'fail', { tier: 'task', durationMs: 100, exitCode: 1 }),
        'issue found',
        '',
        header('test', 'fail', { tier: 'task', durationMs: 5000, exitCode: 1 }),
        '× some test',
        `=== gate outcomes ===`,
        JSON.stringify([
          { name: 'knip', tier: 'task', passed: false, exitCode: 1, duration: 100 },
          { name: 'test', tier: 'task', passed: false, exitCode: 1, duration: 5000 },
        ]),
      ].join('\n'),
    )
    const line = verifyFailureLine(r)
    expect(line).toContain('knip')
    expect(line).toContain('test')
    expect(line).toContain('failed')
  })

  it('falls back to section names when gateOutcomes is null', () => {
    const r = parseVerifyOutput(
      [
        header('typecheck', 'fail', { tier: 'task', durationMs: 2000, exitCode: 1 }),
        'error TS2345',
        // no gate outcomes block
      ].join('\n'),
    )
    const line = verifyFailureLine(r)
    expect(line).toContain('typecheck')
    expect(line).toContain('failed')
  })
})
