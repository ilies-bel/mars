import { describe, expect, it } from 'vitest'
import { distillObservation, type DistillInput, type DistillOutput } from './observation'

describe('distillObservation', () => {
  describe('vitest failure fixture', () => {
    it('preserves every FAIL / Error: / stack-trace line verbatim (byte-for-byte)', () => {
      const failureLines = [
        'FAIL src/core/lib/example.test.ts',
        'Error: expected 1 to equal 2',
        '  AssertionError: expected 1 to equal 2',
        '    at Object.<anonymous> (src/core/lib/example.test.ts:5:14)',
        '    at Promise.then.completed (node_modules/vitest/dist/chunk.js:100:33)',
      ]

      const passingLines = Array.from({ length: 40 }, (_, i) => `✓ passing test ${i} (1ms)`)

      const text = [
        ...passingLines.slice(0, 20),
        ...failureLines,
        ...passingLines.slice(20),
      ].join('\n')

      const input: DistillInput = { text, ref: 'job://abc-123', kind: 'verify' }
      const result: DistillOutput = distillObservation(input)

      // Every FAIL / Error: / stack-trace line is preserved byte-for-byte
      for (const line of failureLines) {
        expect(result.text).toContain(line)
      }

      // Passing lines are collapsed — individual ✓ lines must not appear
      expect(result.text).not.toContain('✓ passing test 0 (1ms)')
      expect(result.text).not.toContain('✓ passing test 39 (1ms)')

      // The summary references the supplied ref
      expect(result.text).toContain('see log: job://abc-123')
    })
  })

  describe('200 PASS lines fixture', () => {
    it('collapses them into a single summary line containing the count and ref', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `PASS src/test-${i}.ts`)
      const text = lines.join('\n')
      const ref = 'log://run-42'

      const result = distillObservation({ text, ref })

      // The output should consist of a single non-empty line
      const nonEmpty = result.text.split('\n').filter((l) => l.length > 0)
      expect(nonEmpty).toHaveLength(1)

      // That line must include the count and the ref
      expect(nonEmpty[0]).toContain('200')
      expect(nonEmpty[0]).toContain(`see log: ${ref}`)
    })
  })

  describe('200_000-char noisy-passing fixture', () => {
    it('produces distilled output under 8_000 chars (≥ 95% reduction)', () => {
      // Build a string of at least 200_000 bytes composed entirely of PASS lines
      const line = 'PASS src/some/very/nested/module.test.ts (12ms)'
      const reps = Math.ceil(200_000 / (line.length + 1)) // +1 for the joining '\n'
      const text = Array.from({ length: reps }, () => line).join('\n').slice(0, 200_000)

      const result = distillObservation({ text, ref: 'artifact://xyz' })

      expect(result.originalBytes).toBeGreaterThanOrEqual(200_000)
      expect(result.distilledBytes).toBeLessThan(8_000)
    })
  })

  describe('determinism', () => {
    it('returns identical output for identical inputs', () => {
      const text = [
        'PASS src/a.ts',
        'FAIL src/b.ts',
        'Error: something broke',
        '  at foo (b.ts:1:2)',
        'ok 1 - passing',
      ].join('\n')

      const r1 = distillObservation({ text, ref: 'ref-1' })
      const r2 = distillObservation({ text, ref: 'ref-1' })

      expect(r1).toEqual(r2)
    })
  })

  describe('metadata fields', () => {
    it('reports originalBytes and distilledBytes correctly', () => {
      const text = 'FAIL src/x.ts\nError: boom'
      const result = distillObservation({ text, ref: 'r' })

      expect(result.originalBytes).toBe(Buffer.byteLength(text, 'utf8'))
      expect(result.distilledBytes).toBe(Buffer.byteLength(result.text, 'utf8'))
      expect(result.distilledBytes).toBeLessThanOrEqual(result.originalBytes)
    })

    it('reports keptLines as the count of verbatim non-passing lines', () => {
      const text = [
        'PASS a',   // passing — collapsed
        'PASS b',   // passing — collapsed
        'FAIL c',   // kept
        'Error: d', // kept
      ].join('\n')

      const result = distillObservation({ text, ref: 'r' })

      // 'FAIL c' and 'Error: d' are kept verbatim
      expect(result.keptLines).toBe(2)
    })
  })
})
