import type { ClaudeEvent } from './claude-stream'

/**
 * Implementor read/grep span watcher.
 *
 * Counts consecutive read-class tool calls (Read/Grep/Glob) emitted by the
 * agent without an interleaving action-class call (Edit/Write/Bash/
 * NotebookEdit/MultiEdit). When the streak crosses the configured limit,
 * the watcher fires an abort callback so the workflow can SIGKILL the
 * claude-code child and surface a `too_hard` failure plus an auto-spawned
 * follow-up task.
 *
 * Tools outside both classes (TaskCreate, TodoWrite, WebFetch, etc.) are
 * ignored — they neither extend nor reset the streak. The watcher is
 * advisory and pure: it never mutates the conversation or queue. The
 * caller wires the abort effect through to the runClaudeCode wrapper's
 * AbortController.
 */
export interface ReadSpanWatcherConfig {
  /**
   * Maximum allowed consecutive read-class calls without an action. Default
   * 5, matching gsd-build/get-shit-done's analysis-paralysis guard.
   * Overridable per-call by the workflow; CLI/env tuning is exposed via
   * `MARS_READ_SPAN_LIMIT`.
   */
  readonly limit: number
  /**
   * Invoked exactly once when the streak first reaches the limit. The
   * caller aborts the claude child and stamps a `too_hard` failure on
   * the task. Subsequent events after firing are still inspected so we
   * can record the full read trail for diagnostics, but onTrip is not
   * called again.
   */
  onTrip: (info: TripInfo) => void
}

export interface ReadSpanTrace {
  readonly tool: 'Read' | 'Grep' | 'Glob'
  readonly target: string
}

export interface TripInfo {
  readonly limit: number
  readonly trace: readonly ReadSpanTrace[]
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const ACTION_TOOLS = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'Bash',
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const targetFromInput = (input: unknown): string => {
  if (!isRecord(input)) return ''
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  if (typeof input.pattern === 'string') return input.pattern
  if (typeof input.command === 'string') return input.command.slice(0, 80)
  return ''
}

interface ToolUseBlock {
  readonly name: string
  readonly input: unknown
}

const extractToolUses = (event: ClaudeEvent): ToolUseBlock[] => {
  if (event.type !== 'assistant') return []
  const message = (event as { message?: unknown }).message
  if (!isRecord(message)) return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const out: ToolUseBlock[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== 'tool_use') continue
    if (typeof block.name !== 'string') continue
    out.push({ name: block.name, input: block.input })
  }
  return out
}

export const resolveReadSpanLimit = (override?: number): number => {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.floor(override)
  }
  const envRaw = process.env.MARS_READ_SPAN_LIMIT
  if (envRaw !== undefined && envRaw.length > 0) {
    const n = Number(envRaw)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return 5
}

export interface ReadSpanWatcher {
  /** Feed one streaming event from the claude-code child. Idempotent. */
  observe(event: ClaudeEvent): void
  /** Current consecutive read-class streak. Resets on every action call. */
  readonly streak: number
  /** Has the watcher already fired onTrip? */
  readonly tripped: boolean
  /** Full read trace since the last action call. */
  readonly trace: readonly ReadSpanTrace[]
}

export const createReadSpanWatcher = (
  config: ReadSpanWatcherConfig,
): ReadSpanWatcher => {
  let streak = 0
  let tripped = false
  let trace: ReadSpanTrace[] = []
  const limit = config.limit

  return {
    get streak() {
      return streak
    },
    get tripped() {
      return tripped
    },
    get trace() {
      return trace
    },
    observe(event) {
      if (tripped) return
      const uses = extractToolUses(event)
      if (uses.length === 0) return
      for (const use of uses) {
        if (READ_TOOLS.has(use.name)) {
          streak += 1
          trace.push({
            tool: use.name as 'Read' | 'Grep' | 'Glob',
            target: targetFromInput(use.input),
          })
          if (streak >= limit && !tripped) {
            tripped = true
            config.onTrip({ limit, trace: [...trace] })
            return
          }
        } else if (ACTION_TOOLS.has(use.name)) {
          streak = 0
          trace = []
        }
        // Other tools (TaskCreate, WebFetch, TodoWrite, etc.) are ignored
        // — they neither extend nor reset the streak.
      }
    },
  }
}
