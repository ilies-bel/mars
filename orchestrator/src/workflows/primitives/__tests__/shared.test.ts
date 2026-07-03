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

  it('parses a line missing the em-dash separator with empty evidence instead of rejecting the block', () => {
    // A line like '- [done] Something -- evidence: file.ts:1' uses '--' (not
    // the em dash U+2014) so it doesn't match the full grammar, but it does
    // match the fallback '- [<status>] <rest>' pattern.  The whole '--
    // evidence: file.ts:1' string becomes the criterion; evidence is ''.
    const text = [
      '```completion-report',
      '- [done] Something -- evidence: file.ts:1',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].status).toBe('done')
    expect(result.lines[0].evidence).toBe('')
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

  // ── Live regression: mars-819c6152 ──────────────────────────────────────
  //
  // The 6-line report emitted by the mars-819c6152 coder session (recorded
  // 2026-07-03T10:35:52Z) had 5 properly-formatted lines and one line that
  // lacked the ' — ' em-dash separator, causing the entire block to be
  // rejected as 'unparseable'.  The fix: tolerate malformed lines per-line
  // rather than failing the whole block.

  it('parses the live mars-819c6152 6-line report: 5 good lines + 1 separator-less line', () => {
    const text = [
      '```completion-report',
      '- [done] Implement the streaming activity-touch path — evidence: src/core/lib/claude-stream.ts:142',
      '- [done] Wire activityTouchFn into the coder worker — evidence: src/core/workers/coder.ts:88',
      '- [done] Add unit test for the streaming touch — evidence: src/core/lib/__tests__/claude-stream.test.ts:55',
      '- [done] Update verify to check pidfile on activity — evidence: src/core/lib/git/verify.ts:210',
      '- [done] Confirm typecheck passes — evidence: npm run typecheck exit 0',
      '- [done] Regression analysis: `recordPid` was never called … confirmed by absence of any activity-touch in the streaming path prior to this fix',
      '```',
    ].join('\n')

    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines).toHaveLength(6)

    // The first 5 lines parse normally with their evidence fields.
    expect(result.lines[0].evidence).toBe('src/core/lib/claude-stream.ts:142')
    expect(result.lines[4].evidence).toBe('npm run typecheck exit 0')

    // The 6th line (no em-dash separator) should parse with empty evidence
    // rather than poisoning the whole block.
    expect(result.lines[5].status).toBe('done')
    expect(result.lines[5].criterion).toContain('Regression analysis')
    expect(result.lines[5].criterion).toContain('recordPid')
    expect(result.lines[5].evidence).toBe('')
  })

  it('remains unparseable when no line has a valid status bracket', () => {
    // An all-garbage block — no line matches even the fallback grammar.
    const text = [
      '```completion-report',
      'totally free-form text with no status bracket',
      'another garbage line',
      '* not a list item with bracket',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('unparseable')
  })

  it('parses mixed block: one valid line + one garbage line → parsed (not poisoned)', () => {
    // A block with one parseable line and one unrecognised line should succeed —
    // the garbage line is silently skipped rather than aborting the parse.
    const text = [
      '```completion-report',
      '- [done] Real criterion — evidence: src/shared.ts:1',
      'totally unrecognised line that matches nothing',
      '```',
    ].join('\n')
    const result = parseCompletionReport(text)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].evidence).toBe('src/shared.ts:1')
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
