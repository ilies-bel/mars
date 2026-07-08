import { describe, expect, it } from 'vitest'
import { digestTask, digestArc } from '../arc-digest'
import type { ClaudeEvent } from '../claude-stream'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to construct synthetic ClaudeEvent fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** One assistant event containing a single tool_use block. */
const assistantWithTool = (
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
): ClaudeEvent => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolUseId, name, input }],
  },
})

/** One user event containing a single tool_result block. */
const userWithResult = (
  toolUseId: string,
  content: string,
  isError = false,
): ClaudeEvent => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
  },
})

const readEvent = (id: string, path: string) =>
  assistantWithTool(id, 'Read', { file_path: path })
const readResult = (id: string, text = 'content', isError = false) =>
  userWithResult(id, text, isError)
const editEvent = (id: string, path: string) =>
  assistantWithTool(id, 'Edit', { file_path: path, old_string: 'a', new_string: 'b' })
const editResult = (id: string, isError = false) => userWithResult(id, 'ok', isError)
const bashEvent = (id: string, cmd: string) =>
  assistantWithTool(id, 'Bash', { command: cmd })
const bashResult = (id: string, out = '', isError = false) =>
  userWithResult(id, out, isError)

// ─────────────────────────────────────────────────────────────────────────────
// digestTask — basic metrics
// ─────────────────────────────────────────────────────────────────────────────

describe('digestTask — repeated reads', () => {
  it('reports no repeated reads when each file is Read once', () => {
    const conversation: ClaudeEvent[] = [
      readEvent('r1', 'a.ts'),
      readResult('r1'),
      readEvent('r2', 'b.ts'),
      readResult('r2'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.repeatedReads).toEqual([])
  })

  it('reports repeated reads when the same path appears multiple times', () => {
    const conversation: ClaudeEvent[] = [
      readEvent('r1', 'foo.ts'),
      readResult('r1'),
      readEvent('r2', 'foo.ts'),
      readResult('r2'),
      readEvent('r3', 'foo.ts'),
      readResult('r3'),
      readEvent('r4', 'bar.ts'),
      readResult('r4'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.repeatedReads).toHaveLength(1)
    expect(d.repeatedReads[0]).toEqual({ path: 'foo.ts', count: 3 })
  })

  it('sorts repeated reads by descending count', () => {
    const conversation: ClaudeEvent[] = [
      readEvent('r1', 'b.ts'), readResult('r1'),
      readEvent('r2', 'b.ts'), readResult('r2'),
      readEvent('r3', 'a.ts'), readResult('r3'),
      readEvent('r4', 'a.ts'), readResult('r4'),
      readEvent('r5', 'a.ts'), readResult('r5'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.repeatedReads[0]?.path).toBe('a.ts')
    expect(d.repeatedReads[0]?.count).toBe(3)
    expect(d.repeatedReads[1]?.path).toBe('b.ts')
  })
})

describe('digestTask — edit-revert pairs', () => {
  it('returns 0 when each file is edited at most once', () => {
    const conversation: ClaudeEvent[] = [
      editEvent('e1', 'a.ts'), editResult('e1'),
      editEvent('e2', 'b.ts'), editResult('e2'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.editRevertPairCount).toBe(0)
  })

  it('counts one pair per extra edit beyond the first for each file', () => {
    const conversation: ClaudeEvent[] = [
      editEvent('e1', 'a.ts'), editResult('e1'),
      editEvent('e2', 'a.ts'), editResult('e2'),  // 2 edits → 1 pair
      editEvent('e3', 'a.ts'), editResult('e3'),  // 3 edits → 2 pairs total
      editEvent('e4', 'b.ts'), editResult('e4'),
      editEvent('e5', 'b.ts'), editResult('e5'),  // 2 edits on b.ts → 1 more pair
    ]
    const d = digestTask('task-1', conversation)
    expect(d.editRevertPairCount).toBe(3)
  })

  it('counts Write calls alongside Edit calls per path', () => {
    const conversation: ClaudeEvent[] = [
      editEvent('e1', 'a.ts'), editResult('e1'),
      assistantWithTool('w1', 'Write', { file_path: 'a.ts', content: 'new' }),
      userWithResult('w1', 'ok'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.editRevertPairCount).toBe(1)
  })
})

describe('digestTask — repeated bash invocations', () => {
  it('returns empty when each command is unique', () => {
    const conversation: ClaudeEvent[] = [
      bashEvent('b1', 'ls -la'), bashResult('b1'),
      bashEvent('b2', 'npm test'), bashResult('b2'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.repeatedBashInvocations).toEqual([])
  })

  it('reports commands invoked more than once', () => {
    const cmd = 'npm run typecheck'
    const conversation: ClaudeEvent[] = [
      bashEvent('b1', cmd), bashResult('b1'),
      bashEvent('b2', cmd), bashResult('b2'),
      bashEvent('b3', cmd), bashResult('b3'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.repeatedBashInvocations).toHaveLength(1)
    expect(d.repeatedBashInvocations[0]).toEqual({ argv: cmd, count: 3 })
  })
})

describe('digestTask — tool error count', () => {
  it('counts tool_result blocks with is_error=true', () => {
    const conversation: ClaudeEvent[] = [
      bashEvent('b1', 'npm test'),
      bashResult('b1', 'FAIL', true),     // error
      bashEvent('b2', 'npm test'),
      bashResult('b2', 'ok', false),      // success
      bashEvent('b3', 'ls'),
      bashResult('b3', '', true),         // error
    ]
    const d = digestTask('task-1', conversation)
    expect(d.toolErrorCount).toBe(2)
  })
})

describe('digestTask — first tool call failure', () => {
  it('sets firstToolCallFailed=false when first call succeeds', () => {
    const conversation: ClaudeEvent[] = [
      readEvent('r1', 'foo.ts'),
      readResult('r1', 'content', false), // success
    ]
    const d = digestTask('task-1', conversation)
    expect(d.firstToolCallFailed).toBe(false)
    expect(d.firstToolCallName).toBeNull()
  })

  it('sets firstToolCallFailed=true and captures the tool name on first-call error', () => {
    const conversation: ClaudeEvent[] = [
      assistantWithTool('b1', 'Bash', { command: 'pnpm install' }),
      userWithResult('b1', 'ENOENT pnpm: command not found', true), // error
      readEvent('r1', 'foo.ts'),
      readResult('r1', 'content', false),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.firstToolCallFailed).toBe(true)
    expect(d.firstToolCallName).toBe('Bash')
  })

  it('sets firstToolCallFailed=false when first call id has no matching result yet', () => {
    // Tool use without matching result → no error recorded yet
    const conversation: ClaudeEvent[] = [
      readEvent('r1', 'foo.ts'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.firstToolCallFailed).toBe(false)
  })
})

describe('digestTask — environmental failure markers', () => {
  it('treats an allowed rate_limit_event as non-environmental (no false positive)', () => {
    // An allowed event is informational — the task ran fine despite the limit event.
    const conversation: ClaudeEvent[] = [
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', overageStatus: 'allowed' },
      } as unknown as ClaudeEvent,
    ]
    const d = digestTask('task-1', conversation)
    expect(d.environmentalFailure).toBe(false)
    expect(d.environmentalFailureReason).toBeNull()
  })

  it('detects a rejected rate_limit_event as environmental failure', () => {
    const conversation: ClaudeEvent[] = [
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1000 },
      } as unknown as ClaudeEvent,
    ]
    const d = digestTask('task-1', conversation)
    expect(d.environmentalFailure).toBe(true)
    expect(d.environmentalFailureReason).toMatch(/rate_limit_event/)
  })

  it('detects synthetic assistant messages (model="<synthetic>")', () => {
    const conversation: ClaudeEvent[] = [
      {
        type: 'assistant',
        message: { role: 'assistant', model: '<synthetic>', content: [] },
      } as unknown as ClaudeEvent,
    ]
    const d = digestTask('task-1', conversation)
    expect(d.environmentalFailure).toBe(true)
    expect(d.environmentalFailureReason).toMatch(/synthetic/)
  })

  it('detects result events with is_error=true and api_error_status=429', () => {
    // Secondary signal: no rate_limit_event, but a hard 429 result.
    const conversation: ClaudeEvent[] = [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 429,
      } as unknown as ClaudeEvent,
    ]
    const d = digestTask('task-1', conversation)
    expect(d.environmentalFailure).toBe(true)
    expect(d.environmentalFailureReason).toMatch(/429/)
  })

  it('combines multiple environmental markers in a single reason string', () => {
    // Rejected rate_limit_event + synthetic assistant → two separate markers.
    const conversation: ClaudeEvent[] = [
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 0 },
      } as unknown as ClaudeEvent,
      {
        type: 'assistant',
        message: { role: 'assistant', model: '<synthetic>', content: [] },
      } as unknown as ClaudeEvent,
    ]
    const d = digestTask('task-1', conversation)
    expect(d.environmentalFailure).toBe(true)
    expect(d.environmentalFailureReason).toContain('rate_limit_event')
    expect(d.environmentalFailureReason).toContain('synthetic')
  })

  it('returns environmentalFailure=false for a normal conversation', () => {
    const conversation: ClaudeEvent[] = [
      readEvent('r1', 'foo.ts'),
      readResult('r1', 'content'),
    ]
    const d = digestTask('task-1', conversation)
    expect(d.environmentalFailure).toBe(false)
    expect(d.environmentalFailureReason).toBeNull()
  })
})

describe('digestTask — turn count', () => {
  it('counts assistant + user events as turns', () => {
    const conversation: ClaudeEvent[] = [
      readEvent('r1', 'foo.ts'),   // assistant → 1
      readResult('r1'),             // user → 2
      readEvent('r2', 'bar.ts'),   // assistant → 3
      readResult('r2'),             // user → 4
      { type: 'result', subtype: 'success' } as ClaudeEvent, // not counted
    ]
    const d = digestTask('task-1', conversation)
    expect(d.turnCount).toBe(4)
  })

  it('returns 0 for an empty conversation', () => {
    const d = digestTask('task-1', [])
    expect(d.turnCount).toBe(0)
    expect(d.toolErrorCount).toBe(0)
    expect(d.editRevertPairCount).toBe(0)
    expect(d.firstToolCallFailed).toBe(false)
    expect(d.environmentalFailure).toBe(false)
  })
})

describe('digestTask — taskId propagation', () => {
  it('preserves the taskId passed in', () => {
    const d = digestTask('mars-abc123', [])
    expect(d.taskId).toBe('mars-abc123')
  })
})

describe('digestArc', () => {
  it('computes independent digests for each task', () => {
    const tasks = [
      {
        taskId: 'task-1',
        conversation: [
          readEvent('r1', 'foo.ts'),
          readResult('r1'),
          readEvent('r2', 'foo.ts'),
          readResult('r2'),
        ],
      },
      {
        taskId: 'task-2',
        conversation: [
          {
            type: 'rate_limit_event',
            rate_limit_info: { status: 'rejected', resetsAt: 0 },
          } as unknown as ClaudeEvent,
        ],
      },
    ]

    const arc = digestArc(tasks)
    expect(arc.tasks).toHaveLength(2)

    expect(arc.tasks[0]!.taskId).toBe('task-1')
    expect(arc.tasks[0]!.repeatedReads).toHaveLength(1)
    expect(arc.tasks[0]!.environmentalFailure).toBe(false)

    expect(arc.tasks[1]!.taskId).toBe('task-2')
    expect(arc.tasks[1]!.repeatedReads).toHaveLength(0)
    expect(arc.tasks[1]!.environmentalFailure).toBe(true)
  })
})
