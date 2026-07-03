import { describe, expect, it } from 'vitest'
import {
  COMPLETION_REPORT_FENCE,
  COMPLETION_REPORT_CONTRACT,
  parseCompletionReport,
  composePrompt,
} from '../shared'

// ---------------------------------------------------------------------------
// parseCompletionReport
// ---------------------------------------------------------------------------

describe('parseCompletionReport', () => {
  it('returns absent when no completion-report block is present', () => {
    const result = parseCompletionReport('some text with no report block')
    expect(result).toEqual({ kind: 'absent' })
  })

  it('parses a single done line', () => {
    const text = [
      'Some output text.',
      '',
      '```completion-report',
      '- [done] Implement the parser — evidence: src/shared.ts:42',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result).toEqual({
      kind: 'parsed',
      lines: [
        {
          status: 'done',
          criterion: 'Implement the parser',
          evidence: 'src/shared.ts:42',
        },
      ],
    })
  })

  it('parses partial and blocked lines', () => {
    const text = [
      '```completion-report',
      '- [done] Export the fence constant — evidence: src/shared.ts:70',
      '- [partial] Add unit tests — evidence: missing coverage for edge cases',
      '- [blocked] Wire into verify phase — evidence: sibling task mars-abc123 not yet done',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines).toHaveLength(3)
    expect(result.lines[0].status).toBe('done')
    expect(result.lines[1].status).toBe('partial')
    expect(result.lines[2].status).toBe('blocked')
  })

  it('uses the LAST completion-report block when multiple appear', () => {
    const text = [
      '```completion-report',
      '- [done] First goal — evidence: commit abc1234',
      '```',
      '',
      'Some more output.',
      '',
      '```completion-report',
      '- [done] Final goal — evidence: commit def5678',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines[0].evidence).toBe('commit def5678')
  })

  it('returns unparseable when a line is missing the em-dash separator', () => {
    const text = [
      '```completion-report',
      '- [done] Something -- evidence: file.ts:1',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('unparseable')
  })

  it('returns unparseable when status is not done/partial/blocked', () => {
    const text = [
      '```completion-report',
      '- [wip] Some criterion — evidence: file.ts:1',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('unparseable')
  })

  it('returns unparseable when the block body is empty', () => {
    const text = ['```completion-report', '```'].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('unparseable')
  })

  it('is total — never throws on arbitrary malformed input', () => {
    const inputs = [
      '',
      '```completion-report',
      '```completion-report\n- broken no separator\n```',
      '\x00\x01\x02',
      '```completion-report\n```completion-report\n```',
      null as unknown as string,
      undefined as unknown as string,
    ]
    for (const input of inputs) {
      expect(() => parseCompletionReport(input)).not.toThrow()
    }
  })

  it('skips blank lines inside the block without treating them as errors', () => {
    const text = [
      '```completion-report',
      '',
      '- [done] Write parser — evidence: src/shared.ts:100',
      '',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines).toHaveLength(1)
  })

  it('captures evidence text verbatim including colons and slashes', () => {
    const text = [
      '```completion-report',
      '- [done] Export types — evidence: src/workflows/primitives/shared.ts:80-90',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines[0].evidence).toBe('src/workflows/primitives/shared.ts:80-90')
  })

  it('parses a keywordless line (no "evidence:" prefix) with the correct evidence field', () => {
    // Coders sometimes write '- [done] <criterion> — <evidence>' without the
    // 'evidence:' keyword.  Both forms must be accepted.
    const text = [
      '```completion-report',
      '- [done] Fix the parser — src/shared.ts:42',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines[0].status).toBe('done')
    expect(result.lines[0].criterion).toBe('Fix the parser')
    expect(result.lines[0].evidence).toBe('src/shared.ts:42')
  })

  it('splits a criterion containing em dashes on the LAST separator', () => {
    // A criterion like "Multi — em — dash criterion" has multiple ' — '
    // occurrences; the greedy regex must choose the rightmost split point.
    const text = [
      '```completion-report',
      '- [done] Multi — em — dash criterion — evidence: src/shared.ts:42',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines[0].criterion).toBe('Multi — em — dash criterion')
    expect(result.lines[0].evidence).toBe('src/shared.ts:42')
  })

  it('splits a keywordless multi-em-dash line on the LAST separator', () => {
    const text = [
      '```completion-report',
      '- [partial] Multi — dash criterion — some evidence text',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines[0].criterion).toBe('Multi — dash criterion')
    expect(result.lines[0].evidence).toBe('some evidence text')
  })
})

// ---------------------------------------------------------------------------
// COMPLETION_REPORT_FENCE
// ---------------------------------------------------------------------------

describe('COMPLETION_REPORT_FENCE', () => {
  it('is the expected info-string', () => {
    expect(COMPLETION_REPORT_FENCE).toBe('completion-report')
  })
})

// ---------------------------------------------------------------------------
// composePrompt — contract injection
// ---------------------------------------------------------------------------

describe('composePrompt', () => {
  it('injects the completion-report contract into every composed prompt', () => {
    const prompt = composePrompt(
      'Fix the bug in foo.ts',
      null,
      'coder',
      null,
      'mars-test01',
      '/tmp/worktree',
    )
    expect(prompt).toContain(COMPLETION_REPORT_CONTRACT)
  })

  it('includes the fence marker so the Worker knows the expected format', () => {
    const prompt = composePrompt(
      'Implement feature X',
      null,
      'coder',
      null,
      'mars-test02',
      '/tmp/worktree',
    )
    // The block opener must appear in the brief so Workers can copy the format.
    expect(prompt).toContain('```' + COMPLETION_REPORT_FENCE)
  })

  it('states that the verify phase parses the report', () => {
    const prompt = composePrompt('Do something', null)
    expect(prompt).toMatch(/verify phase/i)
  })

  it('does NOT compose a completion-report contract for diagnose tasks', () => {
    // diagnose tasks return the prompt verbatim; contract must not be appended.
    const raw = 'Diagnose why the merge failed.'
    const prompt = composePrompt(raw, null, 'coder', null, '', '', 'diagnose')
    expect(prompt).toBe(raw.trim())
    expect(prompt).not.toContain(COMPLETION_REPORT_CONTRACT)
  })
})
