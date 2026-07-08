import { describe, expect, it } from 'vitest'
import { parseDeepReflectionReport, runDeepReflectorArc, buildArcPrompt, capConversation } from '../deep-reflector'
import type { DeepReflectArc } from '../deep-reflect-query'
import type { ClaudeEvent } from '../claude-stream'

describe('parseDeepReflectionReport', () => {
  it('parses a well-formed reflector output', () => {
    const text = JSON.stringify({
      summary: 'task succeeded but did not finish refactor',
      toolCallStats: { total: 12, byName: { Edit: 4, Bash: 3, Read: 5 } },
      dissonantCalls: [
        {
          eventIndex: 7,
          tool: 'Edit',
          stated_intent: 'remove the catch block',
          actual_outcome: 'catch block still present in patched file',
          severity: 'high',
          evidence: '"catch (err) {"',
        },
        {
          eventIndex: 11,
          tool: 'Bash',
          stated_intent: 'commit changes',
          actual_outcome: '"nothing to commit, working tree clean"',
          severity: 'high',
          evidence: '"nothing to commit"',
        },
      ],
      verifyMismatch: {
        claimed: 'tests pass',
        actual: 'typecheck failed: TS2304',
        severity: 'high',
      },
      thrashingPatterns: [
        { pattern: 'same file Read 5+ times', occurrences: 6, evidence: 'src/foo.ts' },
      ],
      rootCause: 'edit landed on the wrong line',
      suggestions: [
        {
          title: 'Add catch-block-removal regression test',
          prompt: 'Add a test in src/foo.test.ts that... Save your work.',
          rationale: 'event 7, 11',
          verdict: 'save',
          target_id: null,
          dup_of: null,
        },
        {
          title: 'Trivial nit',
          prompt: 'fix typo. Save your work.',
          rationale: 'minor',
          verdict: 'drop',
        },
      ],
    })
    const report = parseDeepReflectionReport(text)
    expect(report).not.toBeNull()
    expect(report?.summary).toMatch(/refactor/)
    expect(report?.toolCallStats.total).toBe(12)
    expect(report?.toolCallStats.byName.Edit).toBe(4)
    expect(report?.dissonantCalls).toHaveLength(2)
    expect(report?.dissonantCalls[0].severity).toBe('high')
    expect(report?.verifyMismatch?.severity).toBe('high')
    expect(report?.thrashingPatterns).toHaveLength(1)
    expect(report?.suggestions).toHaveLength(2)
    expect(report?.suggestions[0].verdict).toBe('save')
    expect(report?.suggestions[1].verdict).toBe('drop')
  })

  it('filters out dissonantCalls missing required fields without crashing', () => {
    const text = JSON.stringify({
      summary: 'partial output',
      toolCallStats: { total: 3, byName: { Edit: 3 } },
      dissonantCalls: [
        // valid
        {
          eventIndex: 1,
          tool: 'Edit',
          stated_intent: 'x',
          actual_outcome: 'y',
          severity: 'low',
          evidence: 'q',
        },
        // missing eventIndex
        {
          tool: 'Edit',
          stated_intent: 'x',
          actual_outcome: 'y',
          severity: 'low',
          evidence: 'q',
        },
        // missing severity
        {
          eventIndex: 2,
          tool: 'Edit',
          stated_intent: 'x',
          actual_outcome: 'y',
          evidence: 'q',
        },
        // bad severity value
        {
          eventIndex: 3,
          tool: 'Edit',
          stated_intent: 'x',
          actual_outcome: 'y',
          severity: 'critical',
          evidence: 'q',
        },
        // not an object
        'not an object',
        null,
      ],
      verifyMismatch: null,
      thrashingPatterns: [],
      rootCause: '',
      suggestions: [],
    })
    const report = parseDeepReflectionReport(text)
    expect(report).not.toBeNull()
    expect(report?.dissonantCalls).toHaveLength(1)
    expect(report?.dissonantCalls[0].eventIndex).toBe(1)
  })

  it('returns null for unparseable input', () => {
    expect(parseDeepReflectionReport('not json')).toBeNull()
  })

  it('handles empty arrays gracefully', () => {
    const text = JSON.stringify({
      summary: 'nothing to report',
      toolCallStats: { total: 0, byName: {} },
      dissonantCalls: [],
      verifyMismatch: null,
      thrashingPatterns: [],
      rootCause: 'no signal',
      suggestions: [],
    })
    const report = parseDeepReflectionReport(text)
    expect(report).not.toBeNull()
    expect(report?.dissonantCalls).toEqual([])
    expect(report?.suggestions).toEqual([])
    expect(report?.verifyMismatch).toBeNull()
  })

  it('coerces unknown verdicts to "save" and skips suggestions missing title or prompt', () => {
    const text = JSON.stringify({
      summary: '',
      toolCallStats: { total: 0, byName: {} },
      dissonantCalls: [],
      verifyMismatch: null,
      thrashingPatterns: [],
      rootCause: '',
      suggestions: [
        { title: 'Good', prompt: 'do thing. Save your work.', verdict: 'foo' },
        { title: '', prompt: 'no title' },
        { title: 'No prompt' },
      ],
    })
    const report = parseDeepReflectionReport(text)
    expect(report?.suggestions).toHaveLength(1)
    expect(report?.suggestions[0].verdict).toBe('save')
  })

  it('parses arc-level report with verifyMismatches array', () => {
    const text = JSON.stringify({
      summary: 'arc of 2 tasks: origin failed, recovery succeeded',
      toolCallStats: { total: 24, byName: { Edit: 8, Bash: 6, Read: 10 } },
      dissonantCalls: [
        {
          task_id: 'mars-aaaa1111',
          eventIndex: 5,
          tool: 'Bash',
          stated_intent: 'commit changes',
          actual_outcome: 'nothing to commit',
          severity: 'high',
          evidence: '"nothing to commit, working tree clean"',
        },
      ],
      verifyMismatches: [
        {
          task_id: 'mars-aaaa1111',
          claimed: 'build passes',
          actual: 'tsc error TS2345',
          severity: 'high',
        },
        {
          task_id: 'mars-bbbb2222',
          claimed: 'tests pass',
          actual: '1 test skipped',
          severity: 'medium',
        },
      ],
      thrashingPatterns: [
        {
          pattern: 'same file edited across tasks with no convergence',
          occurrences: 3,
          evidence: 'task mars-aaaa1111 event 2; task mars-bbbb2222 event 4',
        },
      ],
      rootCause: 'the origin task left main dirty, causing the recovery task to conflict',
      suggestions: [
        {
          title: 'Guard commit step',
          prompt: 'Add a pre-commit check. Save your work.',
          rationale: 'event 5 in mars-aaaa1111',
          verdict: 'save',
          target_id: null,
          dup_of: null,
        },
      ],
    })
    const report = parseDeepReflectionReport(text)
    expect(report).not.toBeNull()
    expect(report?.summary).toMatch(/arc of 2 tasks/)
    expect(report?.toolCallStats.total).toBe(24)
    // verifyMismatches (plural) are exposed
    expect(report?.verifyMismatches).toHaveLength(2)
    expect(report?.verifyMismatches?.[0].taskId).toBe('mars-aaaa1111')
    expect(report?.verifyMismatches?.[1].severity).toBe('medium')
    // verifyMismatch (singular) normalised to first entry
    expect(report?.verifyMismatch?.taskId).toBe('mars-aaaa1111')
    // dissonantCalls include task_id
    expect(report?.dissonantCalls).toHaveLength(1)
    expect(report?.dissonantCalls[0].taskId).toBe('mars-aaaa1111')
    expect(report?.thrashingPatterns).toHaveLength(1)
    expect(report?.suggestions).toHaveLength(1)
    expect(report?.suggestions[0].verdict).toBe('save')
  })

  it('normalises singular verifyMismatch into verifyMismatches array', () => {
    const text = JSON.stringify({
      summary: 'single-task output',
      toolCallStats: { total: 5, byName: {} },
      dissonantCalls: [],
      verifyMismatch: { claimed: 'ok', actual: 'fail', severity: 'low' },
      thrashingPatterns: [],
      rootCause: 'typo',
      suggestions: [],
    })
    const report = parseDeepReflectionReport(text)
    expect(report?.verifyMismatch?.severity).toBe('low')
    expect(report?.verifyMismatches).toHaveLength(1)
    expect(report?.verifyMismatches?.[0].severity).toBe('low')
  })

  it('parses scorerSuggestions, clamps confidence, and defaults to [] when absent', () => {
    const withScorers = JSON.stringify({
      summary: 'verify passed vacuously while tests were skipped',
      toolCallStats: { total: 9, byName: { Bash: 9 } },
      dissonantCalls: [],
      verifyMismatches: [
        {
          task_id: 'mars-aaaa1111',
          claimed: 'tests pass',
          actual: '0 tests run',
          severity: 'high',
        },
      ],
      thrashingPatterns: [],
      rootCause: 'no gate grades test-coverage honesty on this pipeline',
      suggestions: [],
      scorerSuggestions: [
        {
          workflow: 'task',
          title: 'Test coverage honesty',
          rubric: 'Grade whether the verify claim is backed by actually-executed tests, 0..1.',
          confidence: 1.7,
          evidence: ['task mars-aaaa1111: "pass" with 0 tests run'],
          verdict: 'save',
        },
        // missing rubric → skipped
        { workflow: 'task', title: 'No rubric', confidence: 0.9 },
        // missing workflow → skipped
        { title: 'No workflow', rubric: 'grade something' },
        // unknown verdict coerces to save; missing confidence defaults to 0.5
        {
          workflow: 'fix',
          title: 'Recovery scope discipline',
          rubric: 'Grade whether the recovery stayed within the origin failure scope.',
          verdict: 'maybe',
        },
      ],
    })
    const report = parseDeepReflectionReport(withScorers)
    expect(report).not.toBeNull()
    expect(report?.scorerSuggestions).toHaveLength(2)
    expect(report?.scorerSuggestions[0].workflow).toBe('task')
    expect(report?.scorerSuggestions[0].confidence).toBe(1) // clamped to 0..1
    expect(report?.scorerSuggestions[0].evidence).toHaveLength(1)
    expect(report?.scorerSuggestions[0].verdict).toBe('save')
    expect(report?.scorerSuggestions[1].confidence).toBe(0.5)
    expect(report?.scorerSuggestions[1].verdict).toBe('save')

    // Absent block → empty array (most arcs have no measurement gap).
    const withoutScorers = JSON.stringify({
      summary: 'nothing to report',
      toolCallStats: { total: 0, byName: {} },
      dissonantCalls: [],
      verifyMismatch: null,
      thrashingPatterns: [],
      rootCause: '',
      suggestions: [],
    })
    expect(parseDeepReflectionReport(withoutScorers)?.scorerSuggestions).toEqual([])
  })
})

describe('runDeepReflectorArc', () => {
  it('is exported and callable', () => {
    // Structural check: the function is exported from deep-reflector
    expect(typeof runDeepReflectorArc).toBe('function')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// capConversation — binary search cap helper
// ─────────────────────────────────────────────────────────────────────────────

describe('capConversation', () => {
  it('passes through a conversation that fits within the cap', () => {
    const events: ClaudeEvent[] = [
      { type: 'assistant', message: { content: 'hello' } } as unknown as ClaudeEvent,
    ]
    const { events: out, elisionNote } = capConversation(events, 1024 * 1024)
    expect(out).toBe(events) // same reference — no copy needed
    expect(elisionNote).toBeNull()
  })

  it('reduces a large conversation to fit within the cap and reports elision', () => {
    // Create 100 events each ~2 KB (200 KB total)
    const big = 'x'.repeat(2000)
    const events: ClaudeEvent[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `r${i}`, content: big }],
      },
    } as unknown as ClaudeEvent))

    const maxBytes = 10 * 1024 // 10 KB cap — well below the 200 KB input
    const { events: out, elisionNote } = capConversation(events, maxBytes)

    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect(elisionNote).not.toBeNull()
    expect(elisionNote).toMatch(/middle events elided/)
    expect(out.length).toBeLessThan(events.length)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildArcPrompt — prompt size budgets and digest embedding
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal valid ArcTaskEntry fixture. */
const makeTaskEntry = (
  taskId: string,
  conversation: ClaudeEvent[],
): DeepReflectArc['tasks'][number] => ({
  taskId,
  status: 'done',
  prompt: 'test task prompt',
  error: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T01:00:00.000Z',
  kind: 'task',
  fixForTaskId: null,
  signals: [],
  scorerResults: [],
  totals: {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    cacheHitRatio: 0,
  },
  conversation,
  verifyOutput: null,
  hasTranscript: true,
  toolCallCounts: {},
  transcriptNotes: [],
})

/** Minimal valid DeepReflectArc fixture. */
const makeArc = (tasks: DeepReflectArc['tasks']): DeepReflectArc => ({
  originId: 'mars-test-arc',
  tasks,
  statusMix: { done: tasks.length },
  taskCount: tasks.length,
  totals: {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalWeightedTokens: 1050,
    cacheHitRatio: 0,
    eventCount: tasks.reduce((s, t) => s + t.conversation.length, 0),
  },
  lastActivity: '2025-01-01T01:00:00.000Z',
  stepTimeline: [],
  toolInvokedErrors: [],
  operatorContext: null,
})

/** Build a single user event containing a large tool_result body. */
const largeResultEvent = (id: string, bodyLength: number): ClaudeEvent => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'A'.repeat(bodyLength),
        is_error: false,
      },
    ],
  },
} as unknown as ClaudeEvent)

/** Build an assistant event with a single Read tool_use. */
const readCallEvent = (id: string, path = 'src/foo.ts'): ClaudeEvent => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: path } }],
  },
} as unknown as ClaudeEvent)

describe('buildArcPrompt — tool_result body truncation', () => {
  it('truncates large tool_result bodies to head+tail', () => {
    // 5000 chars > 400+200 = 600 chars → should be truncated
    const conversation: ClaudeEvent[] = [
      readCallEvent('r1'),
      largeResultEvent('r1', 5000),
    ]
    const arc = makeArc([makeTaskEntry('task-1', conversation)])
    const prompt = buildArcPrompt(arc)

    // The original 5000-char content should not appear verbatim
    expect(prompt).not.toContain('A'.repeat(5000))
    // The truncation marker should appear
    expect(prompt).toContain('chars elided')
  })

  it('does not modify small tool_result bodies', () => {
    const small = 'hello world'
    const conversation: ClaudeEvent[] = [
      readCallEvent('r1'),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'r1', content: small }],
        },
      } as unknown as ClaudeEvent,
    ]
    const arc = makeArc([makeTaskEntry('task-1', conversation)])
    const prompt = buildArcPrompt(arc)
    expect(prompt).toContain(small)
  })
})

describe('buildArcPrompt — prompt size cap and elision markers', () => {
  it('keeps total prompt under 400 KB for a single task with a 4 MB conversation', () => {
    // 800 read+result pairs; each result body is 5000 chars → ~4 MB total
    const conversation: ClaudeEvent[] = []
    for (let i = 0; i < 800; i++) {
      conversation.push(readCallEvent(`r${i}`, `file-${i % 10}.ts`))
      conversation.push(largeResultEvent(`r${i}`, 5000))
    }

    const arc = makeArc([makeTaskEntry('mars-large-task', conversation)])
    const prompt = buildArcPrompt(arc)

    const promptBytes = Buffer.byteLength(prompt, 'utf8')
    expect(promptBytes).toBeLessThanOrEqual(400 * 1024)
  })

  it('emits an elision note when the per-task conversation cap triggers', () => {
    // 500 pairs at 1000 chars each → ~500 KB before truncation, > 150 KB cap
    const conversation: ClaudeEvent[] = []
    for (let i = 0; i < 500; i++) {
      conversation.push(readCallEvent(`r${i}`))
      conversation.push(largeResultEvent(`r${i}`, 1000))
    }

    const arc = makeArc([makeTaskEntry('task-1', conversation)])
    const prompt = buildArcPrompt(arc)

    expect(prompt).toContain('middle events elided')
  })

  it('sets environmentalFailure in digest when conversation contains rate_limit_event', () => {
    const conversation: ClaudeEvent[] = [
      { type: 'rate_limit_event', retry_after: 30 } as unknown as ClaudeEvent,
      readCallEvent('r1'),
      largeResultEvent('r1', 500),
    ]
    const arc = makeArc([makeTaskEntry('task-1', conversation)])
    const prompt = buildArcPrompt(arc)

    // The compact digest JSON is embedded in the prompt
    expect(prompt).toContain('"environmentalFailure":true')
    expect(prompt).toContain('rate_limit_event')
  })
})

describe('buildArcPrompt — step timeline with tool errors', () => {
  it('includes tool_invoked error events in the timeline section', () => {
    const arc: DeepReflectArc = {
      ...makeArc([makeTaskEntry('task-1', [])]),
      toolInvokedErrors: [
        {
          timestamp: '2025-01-01T00:05:00.000Z',
          taskId: 'task-1',
          phase: 'setup',
          tool: 'pnpm',
          argv: ['install', '--frozen-lockfile'],
          exitCode: 254,
          stderr: 'ERR_PNPM_FROZEN_LOCKFILE Lockfile is not up to date',
        },
      ],
    }
    const prompt = buildArcPrompt(arc)
    expect(prompt).toContain('TOOL_ERROR')
    expect(prompt).toContain('pnpm')
    expect(prompt).toContain('exitCode=254')
  })

  it('renders KPI framing in the synthesis instructions', () => {
    const arc = makeArc([makeTaskEntry('task-1', [])])
    const prompt = buildArcPrompt(arc)
    expect(prompt).toContain('Task completeness')
    expect(prompt).toContain('Token cost')
  })

  it('renders environmental failure classification in synthesis instructions', () => {
    const arc = makeArc([makeTaskEntry('task-1', [])])
    const prompt = buildArcPrompt(arc)
    expect(prompt).toContain('environmentalFailure')
    expect(prompt).toContain('infrastructure')
  })
})

