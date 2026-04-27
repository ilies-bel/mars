import { describe, expect, it } from 'bun:test';
import { ReviewSchema } from './review.ts';

describe('ReviewSchema', () => {
  it('accepts a pass with no findings', () => {
    expect(() => ReviewSchema.parse({ verdict: 'pass', findings: [] })).not.toThrow();
  });

  it('accepts a needs-changes with findings', () => {
    expect(() =>
      ReviewSchema.parse({
        verdict: 'needs-changes',
        findings: [{ severity: 'error', message: 'broken', path: 'a.ts', line: 12 }],
      }),
    ).not.toThrow();
  });

  it('rejects an unknown verdict', () => {
    expect(() => ReviewSchema.parse({ verdict: 'maybe', findings: [] })).toThrow();
  });

  it('rejects a finding with an empty message', () => {
    expect(() =>
      ReviewSchema.parse({
        verdict: 'fail',
        findings: [{ severity: 'error', message: '' }],
      }),
    ).toThrow();
  });
});
