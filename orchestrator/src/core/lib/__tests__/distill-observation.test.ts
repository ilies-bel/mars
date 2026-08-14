import { describe, expect, it } from 'vitest'
import { distillObservation } from '../distill-observation'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a realistic noisy vitest run output of approximately `lines` lines. */
function makeNoisyVitestOutput(errorLine: string, lines = 3000): string {
  const noise: string[] = []
  // Simulated module loading / transform noise
  for (let i = 0; i < lines * 0.3; i++) {
    noise.push(`  transform  node_modules/some-dep-${i}/index.js (${i * 7}ms)`)
  }
  // Simulated progress spinner lines
  for (let i = 0; i < lines * 0.3; i++) {
    noise.push(`  ✓ some passing test ${i} [${i}ms]`)
  }
  // Simulated timing / summary noise
  for (let i = 0; i < lines * 0.1; i++) {
    noise.push(`  Duration: ${(i * 0.12).toFixed(2)}s`)
    noise.push(`  ${i}% | ░░░░░░░░░░░░░░░░░░░░░░░░`)
  }
  // Signal: the actual failure
  noise.push('')
  noise.push(' FAIL  src/core/lib/__tests__/some.test.ts')
  noise.push(errorLine)
  noise.push('  Error: expected 1 to equal 2')
  noise.push('    at Object.<anonymous> (src/core/lib/__tests__/some.test.ts:42:5)')
  noise.push('')
  noise.push(' Tests  1 failed | 99 passed (100)')
  // More trailing noise
  for (let i = 0; i < lines * 0.3; i++) {
    noise.push(`  ✓ another passing test ${i} [${i}ms]`)
  }
  return noise.join('\n')
}

// ---------------------------------------------------------------------------
// Pass-through for short inputs
// ---------------------------------------------------------------------------

describe('distillObservation — short inputs', () => {
  it('returns the original text unchanged when input is ≤ 4000 bytes', () => {
    const shortText = 'FAIL src/foo.test.ts\nError: expected 1 to equal 2\n'
    const result = distillObservation({ text: shortText, ref: 'arc://task/t1/verify-output', kind: 'verify' })
    expect(result.text).toBe(shortText)
    expect(result.originalBytes).toBe(Buffer.byteLength(shortText, 'utf8'))
    expect(result.distilledBytes).toBe(result.originalBytes)
  })

  it('threads ref through unchanged', () => {
    const ref = 'arc://task/task-abc123/verify-output'
    const result = distillObservation({ text: 'short', ref, kind: 'verify' })
    expect(result.ref).toBe(ref)
  })
})

// ---------------------------------------------------------------------------
// Distillation of noisy verify output
// ---------------------------------------------------------------------------

describe('distillObservation — verify kind, noisy fixture', () => {
  const FAILING_LINE = '  × should compute the correct sum'

  it('drops prompt size by ≥90% for a noisy 3000-line vitest run', () => {
    const raw = makeNoisyVitestOutput(FAILING_LINE, 3000)
    const result = distillObservation({
      text: raw,
      ref: 'arc://task/task-xyz/verify-output',
      kind: 'verify',
    })

    const ratio = result.distilledBytes / result.originalBytes
    expect(ratio).toBeLessThan(0.10) // ≥90% reduction
  })

  it('preserves the FAIL marker line', () => {
    const raw = makeNoisyVitestOutput(FAILING_LINE, 3000)
    const result = distillObservation({
      text: raw,
      ref: 'arc://task/task-xyz/verify-output',
      kind: 'verify',
    })
    expect(result.text).toContain('FAIL')
    expect(result.text).toContain('some.test.ts')
  })

  it('preserves the Error: diagnostic line', () => {
    const raw = makeNoisyVitestOutput(FAILING_LINE, 3000)
    const result = distillObservation({
      text: raw,
      ref: 'arc://task/task-xyz/verify-output',
      kind: 'verify',
    })
    expect(result.text).toContain('Error: expected 1 to equal 2')
  })

  it('preserves the test summary line', () => {
    const raw = makeNoisyVitestOutput(FAILING_LINE, 3000)
    const result = distillObservation({
      text: raw,
      ref: 'arc://task/task-xyz/verify-output',
      kind: 'verify',
    })
    expect(result.text).toContain('Tests')
    expect(result.text).toContain('failed')
  })

  it('strips purely passing-test lines', () => {
    const raw = makeNoisyVitestOutput(FAILING_LINE, 3000)
    const result = distillObservation({
      text: raw,
      ref: 'arc://task/task-xyz/verify-output',
      kind: 'verify',
    })
    // Passing test lines start with ✓ — should be gone
    const passingLines = result.text
      .split('\n')
      .filter((l) => /^\s*✓/.test(l))
    expect(passingLines.length).toBe(0)
  })

  it('strips timing / progress lines', () => {
    const raw = makeNoisyVitestOutput(FAILING_LINE, 3000)
    const result = distillObservation({
      text: raw,
      ref: 'arc://task/task-xyz/verify-output',
      kind: 'verify',
    })
    // Progress-bar lines contain "░" or "%" + "|"
    const progressLines = result.text
      .split('\n')
      .filter((l) => /\d+%\s*[|│]/.test(l))
    expect(progressLines.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TypeScript error distillation
// ---------------------------------------------------------------------------

describe('distillObservation — TypeScript diagnostics', () => {
  it('preserves "error TS" lines', () => {
    const tsOutput = [
      ...Array.from({ length: 500 }, (_, i) => `  transform  node_modules/dep-${i}.js`),
      'src/foo.ts(12,5): error TS2345: Argument of type "string" is not assignable.',
      'src/bar.ts(8,3): error TS2307: Cannot find module "missing-module".',
      'Found 2 errors.',
      ...Array.from({ length: 500 }, (_, i) => `  ✓ passing test ${i}`),
    ].join('\n')

    const result = distillObservation({
      text: tsOutput,
      ref: 'arc://task/t-ts/verify-output',
      kind: 'verify',
    })

    expect(result.text).toContain('error TS2345')
    expect(result.text).toContain('error TS2307')
    expect(result.text).toContain('Found 2 errors')
    expect(result.distilledBytes).toBeLessThan(result.originalBytes * 0.5)
  })
})

// ---------------------------------------------------------------------------
// Fallback: distilled ≥ original → return original unchanged
// ---------------------------------------------------------------------------

describe('distillObservation — no-savings fallback', () => {
  it('returns original when distillation saves nothing', () => {
    // A large input that is 100% signal lines — distillation cannot compress it
    const allErrors = Array.from(
      { length: 600 },
      (_, i) => `FAIL src/file${i}.test.ts > suite > test ${i}\n  Error: bang ${i}`,
    ).join('\n')

    const result = distillObservation({
      text: allErrors,
      ref: 'arc://task/t-dense/verify-output',
      kind: 'verify',
    })

    // Should NOT have expanded
    expect(result.distilledBytes).toBeLessThanOrEqual(result.originalBytes)
  })
})

// ---------------------------------------------------------------------------
// Structural: returned fields
// ---------------------------------------------------------------------------

describe('distillObservation — return shape', () => {
  it('originalBytes reflects byte count of input', () => {
    const raw = makeNoisyVitestOutput('× failing test', 200)
    const result = distillObservation({
      text: raw,
      ref: 'arc://task/t-shape/verify-output',
      kind: 'verify',
    })
    expect(result.originalBytes).toBe(Buffer.byteLength(raw, 'utf8'))
  })

  it('distilledBytes reflects byte count of result.text', () => {
    const raw = makeNoisyVitestOutput('× failing test', 200)
    const result = distillObservation({
      text: raw,
      ref: 'arc://task/t-shape/verify-output',
      kind: 'verify',
    })
    expect(result.distilledBytes).toBe(Buffer.byteLength(result.text, 'utf8'))
  })
})
