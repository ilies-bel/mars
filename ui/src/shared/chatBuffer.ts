/**
 * chatBuffer — pure reducer for live assistant streaming.
 *
 * Keeps an ORDERED list of LiveSegment items so the natural
 * text ↔ thinking ↔ tool ↔ text interleaving is preserved exactly as it
 * arrives from the stream.
 *
 * No React dependencies — this module is plain TypeScript and is tested in
 * isolation via chatBuffer.test.ts. ChatPage.tsx consumes it to drive
 * LiveAssistantBubble.
 */

// ---------------------------------------------------------------------------
// Segment model
// ---------------------------------------------------------------------------

export type TextSegment = {
  type: 'text'
  text: string
}

export type ThinkingSegment = {
  type: 'thinking'
  text: string
}

export type ToolEntry = {
  toolUseId: string
  toolName: string
  input: unknown
  /**
   * Mirrors the AI SDK ToolUIPart state so live and persisted rendering
   * use the same status labels:
   *   input-streaming  — tool call started, input is being streamed
   *   input-available  — input complete, tool is executing
   *   output-available — tool completed successfully
   *   output-error     — tool call failed
   */
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  output?: unknown
  errorText?: string
}

/** A run of consecutive tool calls shares a single group so they render together. */
export type ToolGroupSegment = {
  type: 'tool_group'
  tools: ToolEntry[]
}

export type LiveSegment = TextSegment | ThinkingSegment | ToolGroupSegment

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

export type LiveBuffer = {
  readonly segments: readonly LiveSegment[]
  readonly done: boolean
  readonly error?: string
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type LiveEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool_input_available'; toolUseId: string }
  | { type: 'tool_result'; toolUseId: string; output?: unknown; errorText?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export const emptyLiveBuffer = (): LiveBuffer => ({ segments: [], done: false })

/**
 * Pure reducer: apply one streaming event to the current buffer and return a
 * new buffer. Immutable — never mutates `buf`.
 *
 * Rules that preserve ordering:
 * - `text`: append to the trailing TextSegment when the last segment is text
 *   (consecutive deltas coalesce); otherwise push a new TextSegment.
 * - `thinking`: replace the trailing ThinkingSegment if the last segment is
 *   thinking (the model updates its chain-of-thought in place); otherwise push
 *   a new ThinkingSegment.
 * - `tool_use`: extend the trailing ToolGroupSegment when the last segment is
 *   a tool group (parallel / consecutive calls share one group); otherwise
 *   push a new ToolGroupSegment. New tool enters `input-streaming` state.
 * - `tool_input_available`: walk backwards to find the matching tool and
 *   advance its state from `input-streaming` to `input-available`.
 * - `tool_result`: walk backwards to find the last ToolGroupSegment that
 *   contains a matching toolUseId and update that entry to `output-available`
 *   or `output-error` in place.
 */
export function applyLiveEvent(buf: LiveBuffer, event: LiveEvent): LiveBuffer {
  const segs = buf.segments as LiveSegment[]

  if (event.type === 'text') {
    const last = segs[segs.length - 1]
    if (last?.type === 'text') {
      return {
        ...buf,
        segments: [...segs.slice(0, -1), { type: 'text', text: last.text + event.text }],
      }
    }
    return { ...buf, segments: [...segs, { type: 'text', text: event.text }] }
  }

  if (event.type === 'thinking') {
    const last = segs[segs.length - 1]
    if (last?.type === 'thinking') {
      return {
        ...buf,
        segments: [...segs.slice(0, -1), { type: 'thinking', text: event.text }],
      }
    }
    return { ...buf, segments: [...segs, { type: 'thinking', text: event.text }] }
  }

  if (event.type === 'tool_use') {
    const newTool: ToolEntry = {
      toolUseId: event.toolUseId,
      toolName: event.toolName,
      input: event.input,
      state: 'input-streaming',
    }
    const last = segs[segs.length - 1]
    if (last?.type === 'tool_group') {
      return {
        ...buf,
        segments: [
          ...segs.slice(0, -1),
          { type: 'tool_group', tools: [...last.tools, newTool] },
        ],
      }
    }
    return { ...buf, segments: [...segs, { type: 'tool_group', tools: [newTool] }] }
  }

  if (event.type === 'tool_input_available') {
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i]
      if (seg?.type !== 'tool_group') continue
      const toolIdx = seg.tools.findIndex((t) => t.toolUseId === event.toolUseId)
      if (toolIdx === -1) continue
      const updated: ToolEntry = { ...seg.tools[toolIdx]!, state: 'input-available' }
      return {
        ...buf,
        segments: [
          ...segs.slice(0, i),
          { type: 'tool_group', tools: seg.tools.map((t, j) => (j === toolIdx ? updated : t)) },
          ...segs.slice(i + 1),
        ],
      }
    }
    return buf
  }

  if (event.type === 'tool_result') {
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i]
      if (seg?.type !== 'tool_group') continue
      const toolIdx = seg.tools.findIndex((t) => t.toolUseId === event.toolUseId)
      if (toolIdx === -1) continue
      const updated: ToolEntry = event.errorText != null
        ? { ...seg.tools[toolIdx]!, state: 'output-error', errorText: event.errorText }
        : { ...seg.tools[toolIdx]!, state: 'output-available', output: event.output }
      return {
        ...buf,
        segments: [
          ...segs.slice(0, i),
          { type: 'tool_group', tools: seg.tools.map((t, j) => (j === toolIdx ? updated : t)) },
          ...segs.slice(i + 1),
        ],
      }
    }
    return buf
  }

  if (event.type === 'done') return { ...buf, done: true }
  if (event.type === 'error') return { ...buf, done: true, error: event.message }

  return buf
}
