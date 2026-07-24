/**
 * chatBuffer.test.ts — behaviour tests for the LiveBuffer reducer.
 *
 * Verifies the ordered-segment contract: text/thinking/tool events land in the
 * correct order, consecutive deltas coalesce, tool results attach to the right
 * tool entry, and done/error flags propagate cleanly.
 */

import { describe, it, expect } from 'bun:test'
import { emptyLiveBuffer, applyLiveEvent } from './chatBuffer'
import type { LiveBuffer, LiveEvent, LiveSegment, ToolGroupSegment } from './chatBuffer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply a sequence of events to an empty buffer. */
const applyAll = (events: LiveEvent[]): LiveBuffer =>
  events.reduce((buf, ev) => applyLiveEvent(buf, ev), emptyLiveBuffer())

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('emptyLiveBuffer', () => {
  it('starts with no segments and done=false', () => {
    const buf = emptyLiveBuffer()
    expect(buf.segments).toEqual([])
    expect(buf.done).toBe(false)
    expect(buf.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// text events
// ---------------------------------------------------------------------------

describe('applyLiveEvent — text', () => {
  it('creates a TextSegment from the first text event', () => {
    const buf = applyAll([{ type: 'text', text: 'hello' }])
    expect(buf.segments).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('coalesces consecutive text events into one TextSegment', () => {
    const buf = applyAll([
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
    ])
    expect(buf.segments).toHaveLength(1)
    expect(buf.segments[0]).toEqual({ type: 'text', text: 'hello world' })
  })

  it('starts a new TextSegment after a tool group (preserving interleaving)', () => {
    const buf = applyAll([
      { type: 'text', text: 'before' },
      { type: 'tool_use', toolUseId: 'id1', toolName: 'Bash', input: {} },
      { type: 'text', text: 'after' },
    ])
    expect(buf.segments).toHaveLength(3)
    expect(buf.segments[0]).toEqual({ type: 'text', text: 'before' })
    expect(buf.segments[1]).toMatchObject({ type: 'tool_group' })
    expect(buf.segments[2]).toEqual({ type: 'text', text: 'after' })
  })

  it('starts a new TextSegment after a thinking segment', () => {
    const buf = applyAll([
      { type: 'thinking', text: 'pondering…' },
      { type: 'text', text: 'answer' },
    ])
    expect(buf.segments).toHaveLength(2)
    expect(buf.segments[0]!.type).toBe('thinking')
    expect(buf.segments[1]).toEqual({ type: 'text', text: 'answer' })
  })

  it('does not mutate the previous buffer (immutable)', () => {
    const orig = emptyLiveBuffer()
    const next = applyLiveEvent(orig, { type: 'text', text: 'hi' })
    expect(orig.segments).toHaveLength(0)
    expect(next.segments).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// thinking events
// ---------------------------------------------------------------------------

describe('applyLiveEvent — thinking', () => {
  it('creates a ThinkingSegment', () => {
    const buf = applyAll([{ type: 'thinking', text: 'thinking…' }])
    expect(buf.segments).toEqual([{ type: 'thinking', text: 'thinking…' }])
  })

  it('replaces a trailing ThinkingSegment (model updates chain-of-thought in place)', () => {
    const buf = applyAll([
      { type: 'thinking', text: 'draft 1' },
      { type: 'thinking', text: 'draft 2' },
    ])
    expect(buf.segments).toHaveLength(1)
    expect(buf.segments[0]).toEqual({ type: 'thinking', text: 'draft 2' })
  })

  it('pushes a new ThinkingSegment after text (interleaving preserved)', () => {
    const buf = applyAll([
      { type: 'text', text: 'answer' },
      { type: 'thinking', text: 'second thought' },
    ])
    expect(buf.segments).toHaveLength(2)
    expect(buf.segments[0]!.type).toBe('text')
    expect(buf.segments[1]).toEqual({ type: 'thinking', text: 'second thought' })
  })
})

// ---------------------------------------------------------------------------
// tool_use events
// ---------------------------------------------------------------------------

describe('applyLiveEvent — tool_use', () => {
  it('creates a ToolGroupSegment with a pending ToolEntry', () => {
    const buf = applyAll([{ type: 'tool_use', toolUseId: 'id1', toolName: 'Bash', input: { cmd: 'ls' } }])
    expect(buf.segments).toHaveLength(1)
    expect(buf.segments[0]).toMatchObject({
      type: 'tool_group',
      tools: [{ toolUseId: 'id1', toolName: 'Bash', state: 'pending', input: { cmd: 'ls' } }],
    })
  })

  it('extends the trailing ToolGroupSegment with consecutive tool_use events', () => {
    const buf = applyAll([
      { type: 'tool_use', toolUseId: 'id1', toolName: 'Read', input: {} },
      { type: 'tool_use', toolUseId: 'id2', toolName: 'Bash', input: {} },
    ])
    expect(buf.segments).toHaveLength(1)
    const group = buf.segments[0] as ToolGroupSegment
    expect(group.tools).toHaveLength(2)
    expect(group.tools[0]!.toolUseId).toBe('id1')
    expect(group.tools[1]!.toolUseId).toBe('id2')
  })

  it('starts a new ToolGroupSegment after text (text→tool interleaving)', () => {
    const buf = applyAll([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', toolUseId: 'id1', toolName: 'Bash', input: {} },
    ])
    expect(buf.segments).toHaveLength(2)
    expect(buf.segments[0]!.type).toBe('text')
    expect(buf.segments[1]!.type).toBe('tool_group')
  })
})

// ---------------------------------------------------------------------------
// tool_result events
// ---------------------------------------------------------------------------

describe('applyLiveEvent — tool_result', () => {
  it('attaches a result to the matching tool by toolUseId', () => {
    const buf = applyAll([
      { type: 'tool_use', toolUseId: 'id1', toolName: 'Bash', input: {} },
      { type: 'tool_result', toolUseId: 'id1', output: 'file.ts' },
    ])
    const group = buf.segments[0] as ToolGroupSegment
    expect(group.tools[0]!.state).toBe('done')
    expect(group.tools[0]!.output).toBe('file.ts')
  })

  it('marks the tool as error when errorText is provided', () => {
    const buf = applyAll([
      { type: 'tool_use', toolUseId: 'id1', toolName: 'Bash', input: {} },
      { type: 'tool_result', toolUseId: 'id1', errorText: 'Permission denied' },
    ])
    const group = buf.segments[0] as ToolGroupSegment
    expect(group.tools[0]!.state).toBe('error')
    expect(group.tools[0]!.errorText).toBe('Permission denied')
  })

  it('attaches result to the correct tool when group has multiple tools', () => {
    const buf = applyAll([
      { type: 'tool_use', toolUseId: 'a', toolName: 'Read', input: {} },
      { type: 'tool_use', toolUseId: 'b', toolName: 'Bash', input: {} },
      { type: 'tool_result', toolUseId: 'a', output: 'content' },
      { type: 'tool_result', toolUseId: 'b', output: 'output' },
    ])
    const group = buf.segments[0] as ToolGroupSegment
    expect(group.tools[0]!.output).toBe('content')
    expect(group.tools[1]!.output).toBe('output')
  })

  it('leaves an unmatched tool_result as a no-op (no crash)', () => {
    const buf = applyAll([
      { type: 'tool_result', toolUseId: 'unknown', output: 'x' },
    ])
    expect(buf.segments).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Full text → tool → text interleaving (the core ordering guarantee)
// ---------------------------------------------------------------------------

describe('ordering — text/tool/text interleaving', () => {
  it('produces 3 ordered segments: text, tool_group, text', () => {
    const buf = applyAll([
      { type: 'text', text: 'I will run a command.' },
      { type: 'tool_use', toolUseId: 'id1', toolName: 'Bash', input: { cmd: 'ls' } },
      { type: 'tool_result', toolUseId: 'id1', output: 'file.ts' },
      { type: 'text', text: 'Done.' },
    ])
    expect(buf.segments).toHaveLength(3)
    const types = buf.segments.map((s) => s.type)
    expect(types).toEqual(['text', 'tool_group', 'text'])
  })

  it('coalesces the pre-tool and post-tool text independently', () => {
    const buf = applyAll([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'tool_use', toolUseId: 'id1', toolName: 'Bash', input: {} },
      { type: 'text', text: 'C' },
      { type: 'text', text: 'D' },
    ])
    expect(buf.segments).toHaveLength(3)
    const [first, , last] = buf.segments as [LiveSegment, LiveSegment, LiveSegment]
    expect((first as { text: string }).text).toBe('AB')
    expect((last as { text: string }).text).toBe('CD')
  })

  it('supports two separate tool groups separated by text', () => {
    const buf = applyAll([
      { type: 'tool_use', toolUseId: 'a', toolName: 'Read', input: {} },
      { type: 'tool_result', toolUseId: 'a', output: 'r1' },
      { type: 'text', text: 'in between' },
      { type: 'tool_use', toolUseId: 'b', toolName: 'Bash', input: {} },
      { type: 'tool_result', toolUseId: 'b', output: 'r2' },
    ])
    expect(buf.segments).toHaveLength(3)
    expect(buf.segments[0]!.type).toBe('tool_group')
    expect(buf.segments[1]!.type).toBe('text')
    expect(buf.segments[2]!.type).toBe('tool_group')
  })
})

// ---------------------------------------------------------------------------
// done / error
// ---------------------------------------------------------------------------

describe('applyLiveEvent — done / error', () => {
  it('marks the buffer as done', () => {
    const buf = applyAll([
      { type: 'text', text: 'hello' },
      { type: 'done' },
    ])
    expect(buf.done).toBe(true)
    expect(buf.error).toBeUndefined()
  })

  it('marks the buffer as done with an error message', () => {
    const buf = applyAll([{ type: 'error', message: 'network failure' }])
    expect(buf.done).toBe(true)
    expect(buf.error).toBe('network failure')
  })

  it('segments accumulated before done are still accessible', () => {
    const buf = applyAll([
      { type: 'text', text: 'partial' },
      { type: 'done' },
    ])
    expect(buf.segments).toHaveLength(1)
    expect(buf.segments[0]).toEqual({ type: 'text', text: 'partial' })
  })
})
