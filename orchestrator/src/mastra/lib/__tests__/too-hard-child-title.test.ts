import { describe, expect, it } from 'vitest'
import {
  CAUSE_BUDGET,
  summarizeReadCause,
  type ReadSpanTrace,
} from '../read-span-watch'

const read = (target: string): ReadSpanTrace => ({ tool: 'Read', target })
const grep = (target: string): ReadSpanTrace => ({ tool: 'Grep', target })
const glob = (target: string): ReadSpanTrace => ({ tool: 'Glob', target })

describe('summarizeReadCause', () => {
  it('de-dups repeated targets to a single token', () => {
    const trace = [
      read('/repo/src/cli.ts'),
      read('/repo/src/cli.ts'),
      read('/repo/src/cli.ts'),
    ]
    expect(summarizeReadCause(trace)).toBe('cli.ts')
  })

  it('de-dups distinct paths that share a basename', () => {
    const trace = [read('/a/cli.ts'), read('/b/cli.ts')]
    expect(summarizeReadCause(trace)).toBe('cli.ts')
  })

  it('orders targets last-seen-first (tail of the loop leads)', () => {
    const trace = [
      read('/repo/a.ts'),
      read('/repo/b.ts'),
      read('/repo/c.ts'),
    ]
    expect(summarizeReadCause(trace)).toBe('c.ts, b.ts, a.ts')
  })

  it('basenames path-like file targets', () => {
    const trace = [read('/Users/x/project/orchestrator/src/mastra/lib/read-span-watch.ts')]
    expect(summarizeReadCause(trace)).toBe('read-span-watch.ts')
  })

  it('shows Grep pattern targets verbatim (no slash → not basenamed)', () => {
    const trace = [grep('createReadSpanWatcher'), read('/repo/src/cli.ts')]
    // last-seen-first: the Grep pattern was first, so it trails.
    expect(summarizeReadCause(trace)).toBe('cli.ts, createReadSpanWatcher')
  })

  it('basenames Glob path targets too', () => {
    const trace = [glob('/repo/src/foo.test.ts')]
    expect(summarizeReadCause(trace)).toBe('foo.test.ts')
  })

  it('returns empty string for an empty trace (generic-title fallback)', () => {
    expect(summarizeReadCause([])).toBe('')
  })

  it('returns empty string when every target is blank/whitespace', () => {
    const trace = [read(''), grep('   '), read('')]
    expect(summarizeReadCause(trace)).toBe('')
  })

  it('skips blank targets but keeps the usable ones', () => {
    const trace = [read(''), read('/repo/keep.ts'), grep('  ')]
    expect(summarizeReadCause(trace)).toBe('keep.ts')
  })

  it('caps the fragment to CAUSE_BUDGET and marks dropped targets', () => {
    const trace = Array.from({ length: 12 }, (_, i) =>
      read(`/repo/some-fairly-long-filename-${i}.ts`),
    )
    const out = summarizeReadCause(trace)
    expect(out.endsWith('…')).toBe(true)
    // Joined fragment (excluding the trailing ellipsis) must fit budget.
    expect(out.replace(/…$/, '').length).toBeLessThanOrEqual(CAUSE_BUDGET)
    // Newest target leads so it survives `mars list` truncation.
    expect(out.startsWith('some-fairly-long-filename-11.ts')).toBe(true)
  })

  it('hard-truncates a lone head token wider than the whole budget', () => {
    const huge = `/repo/${'x'.repeat(CAUSE_BUDGET + 30)}.ts`
    const out = summarizeReadCause([read(huge)])
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(CAUSE_BUDGET)
  })

  it('keeps the composed first line within a sane width budget', () => {
    const trace = Array.from({ length: 8 }, (_, i) =>
      read(`/repo/path/component-${i}.tsx`),
    )
    const stem = '# Context-gathering for mars-e1e16cee'
    const cause = summarizeReadCause(trace)
    const firstLine = cause ? `${stem}: stuck reading ${cause}` : stem
    // stem + ": stuck reading " + capped cause (+1 for trailing ellipsis).
    expect(firstLine.length).toBeLessThanOrEqual(
      stem.length + ': stuck reading '.length + CAUSE_BUDGET + 1,
    )
  })
})
