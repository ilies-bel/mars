import type { ClaudeEvent } from './claude-stream'

/**
 * Mechanical, LLM-free digest of one task's ClaudeEvent[] conversation.
 * All metrics are computed from the event array with no external calls or I/O.
 */
export interface TaskDigest {
  taskId: string
  /** Paths Read more than once during this task, sorted by descending count. */
  repeatedReads: Array<{ path: string; count: number }>
  /**
   * Estimated count of Edit/Write-then-revert pairs:
   * for every file edited ≥ 2 times, contributes (edit_count − 1) to this total.
   * A file touched exactly twice contributes 1; three times contributes 2; etc.
   */
  editRevertPairCount: number
  /** Bash command strings invoked more than once, sorted by descending count. */
  repeatedBashInvocations: Array<{ argv: string; count: number }>
  /** Count of tool_result blocks with is_error=true across this task. */
  toolErrorCount: number
  /** True when the first tool call in the session returned is_error=true. */
  firstToolCallFailed: boolean
  /** Name of the first tool call when firstToolCallFailed is true; null otherwise. */
  firstToolCallName: string | null
  /** True when environmental failure markers were detected in the conversation. */
  environmentalFailure: boolean
  /**
   * Semicolon-separated list of detected environmental failure reasons,
   * or null when environmentalFailure is false.
   *
   * Markers detected:
   * - rate_limit_event: a top-level { type: 'rate_limit_event' } event
   * - synthetic assistant: an assistant message with message.model === '<synthetic>'
   * - api_error_status: a result event with a non-undefined api_error_status field
   */
  environmentalFailureReason: string | null
  /** Total assistant+user event count. */
  turnCount: number
}

export interface ArcDigest {
  tasks: TaskDigest[]
}

/** Extract file path from a tool input object (Read / Edit / Write). */
const getFilePath = (input: Record<string, unknown>): string | null => {
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  return null
}

/** Extract the command string from a Bash tool input. */
const getBashCommand = (input: Record<string, unknown>): string | null =>
  typeof input.command === 'string' ? input.command : null

/**
 * Extract all tool_use calls from a ClaudeEvent.
 *
 * Handles two shapes:
 * 1. A top-level `{ type: 'tool_use', id, name, input }` event (older CLI versions).
 * 2. `tool_use` blocks inside `message.content` on `assistant` events (current format).
 */
const extractToolUses = (
  event: ClaudeEvent,
): Array<{ id: string; name: string; input: Record<string, unknown> }> => {
  if (event.type === 'tool_use') {
    const id = typeof event.id === 'string' ? event.id : null
    const name = typeof event.name === 'string' ? event.name : null
    if (id && name) {
      const input =
        event.input && typeof event.input === 'object' && !Array.isArray(event.input)
          ? (event.input as Record<string, unknown>)
          : {}
      return [{ id, name, input }]
    }
    return []
  }

  if (event.type !== 'assistant') return []
  const msg = event.message
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return []
  const content = (msg as Record<string, unknown>).content
  if (!Array.isArray(content)) return []

  const result: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    const b = block as Record<string, unknown>
    if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      const input =
        b.input && typeof b.input === 'object' && !Array.isArray(b.input)
          ? (b.input as Record<string, unknown>)
          : {}
      result.push({ id: b.id, name: b.name, input })
    }
  }
  return result
}

/**
 * Extract all tool_result blocks from a ClaudeEvent (user messages).
 * Tool results live in `message.content[i].type === 'tool_result'`.
 */
const extractToolResults = (
  event: ClaudeEvent,
): Array<{ toolUseId: string; isError: boolean }> => {
  if (event.type !== 'user') return []
  const msg = event.message
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return []
  const content = (msg as Record<string, unknown>).content
  if (!Array.isArray(content)) return []

  const result: Array<{ toolUseId: string; isError: boolean }> = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue
    const b = block as Record<string, unknown>
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      result.push({ toolUseId: b.tool_use_id, isError: Boolean(b.is_error) })
    }
  }
  return result
}

/**
 * Compute a mechanical, LLM-free digest for one task's ClaudeEvent[] conversation.
 * No I/O, no external calls. Safe to call on an empty conversation.
 */
export const digestTask = (taskId: string, conversation: ClaudeEvent[]): TaskDigest => {
  const readCounts = new Map<string, number>()
  const editCounts = new Map<string, number>()
  const bashCounts = new Map<string, number>()

  // Map from tool_use id → tool name, to look up first call on error.
  const toolUseById = new Map<string, string>()
  // Set of tool_use ids whose matching tool_result had is_error=true.
  const erroredToolUseIds = new Set<string>()

  let firstToolUseId: string | null = null
  let toolErrorCount = 0
  let turnCount = 0
  const envReasons: string[] = []

  for (const event of conversation) {
    if (event.type === 'assistant' || event.type === 'user') turnCount++

    // ── Environmental failure markers ──────────────────────────────────────
    if (event.type === 'rate_limit_event') {
      envReasons.push('rate_limit_event detected')
    }

    if (event.type === 'assistant') {
      const msg = event.message
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
        const model = (msg as Record<string, unknown>).model
        if (model === '<synthetic>') {
          envReasons.push('synthetic assistant message (model="<synthetic>")')
        }
      }
    }

    if (event.type === 'result' && event.api_error_status !== undefined) {
      envReasons.push(`result event with api_error_status=${String(event.api_error_status)}`)
    }

    // ── Tool use extraction ────────────────────────────────────────────────
    for (const tu of extractToolUses(event)) {
      if (firstToolUseId === null) firstToolUseId = tu.id
      toolUseById.set(tu.id, tu.name)

      if (tu.name === 'Read') {
        const path = getFilePath(tu.input)
        if (path) readCounts.set(path, (readCounts.get(path) ?? 0) + 1)
      } else if (tu.name === 'Edit' || tu.name === 'Write' || tu.name === 'MultiEdit') {
        const path = getFilePath(tu.input)
        if (path) editCounts.set(path, (editCounts.get(path) ?? 0) + 1)
      } else if (tu.name === 'Bash') {
        const cmd = getBashCommand(tu.input)
        if (cmd) {
          const trimmed = cmd.trim()
          bashCounts.set(trimmed, (bashCounts.get(trimmed) ?? 0) + 1)
        }
      }
    }

    // ── Tool result extraction ─────────────────────────────────────────────
    for (const tr of extractToolResults(event)) {
      if (tr.isError) {
        erroredToolUseIds.add(tr.toolUseId)
        toolErrorCount++
      }
    }
  }

  // ── Derived metrics ────────────────────────────────────────────────────────

  const repeatedReads = Array.from(readCounts.entries())
    .filter(([, c]) => c > 1)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)

  let editRevertPairCount = 0
  for (const [, c] of editCounts.entries()) {
    if (c >= 2) editRevertPairCount += c - 1
  }

  const repeatedBashInvocations = Array.from(bashCounts.entries())
    .filter(([, c]) => c > 1)
    .map(([argv, count]) => ({ argv, count }))
    .sort((a, b) => b.count - a.count)

  const firstToolCallFailed =
    firstToolUseId !== null && erroredToolUseIds.has(firstToolUseId)
  const firstToolCallName = firstToolCallFailed ? (toolUseById.get(firstToolUseId!) ?? null) : null

  const envFail = envReasons.length > 0
  return {
    taskId,
    repeatedReads,
    editRevertPairCount,
    repeatedBashInvocations,
    toolErrorCount,
    firstToolCallFailed,
    firstToolCallName,
    environmentalFailure: envFail,
    environmentalFailureReason: envFail ? envReasons.join('; ') : null,
    turnCount,
  }
}

/**
 * Compute mechanical digests for all tasks in an arc.
 */
export const digestArc = (
  tasks: ReadonlyArray<{ taskId: string; conversation: ClaudeEvent[] }>,
): ArcDigest => ({
  tasks: tasks.map((t) => digestTask(t.taskId, t.conversation)),
})
