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

/**
 * Max width of the cause fragment summarised into the context-gathering
 * child task title. `mars list` renders `prompt.slice(0, 60)`; the
 * parent-id stem (`# Context-gathering for mars-xxxxxxxx`) eats most of
 * that, so the fragment is capped tight and the strongest-signal target
 * is placed first (see {@link summarizeReadCause}) so it survives the
 * 60-char truncation even when the full first line is longer.
 */
export const CAUSE_BUDGET = 48

const displayTarget = (t: ReadSpanTrace): string => {
  const raw = t.target.trim()
  if (raw.length === 0) return ''
  // Path-like (Read/Glob file paths, Grep with a path target): basename
  // it to save width. Grep patterns / bare names / clipped Bash commands
  // have no slash and are shown verbatim.
  if (raw.includes('/')) {
    const base = raw.slice(raw.lastIndexOf('/') + 1)
    return base.length > 0 ? base : raw
  }
  return raw
}

/**
 * Summarise *why* the implementor stalled into a short cause fragment
 * for the context-gathering child task title, so `mars list` shows the
 * looped-on files/patterns instead of a wall of identical generic rows.
 *
 * - de-dups on the displayed token (so `/a/x.ts` and `/b/x.ts` collapse),
 * - orders newest → oldest (the tail of the read loop is the strongest
 *   signal and is what survives `mars list`'s 60-char truncation),
 * - basenames path-like targets, shows Grep patterns verbatim,
 * - drops blank targets; returns `''` when nothing usable remains so the
 *   caller can fall back to the generic title with no colon suffix,
 * - caps the joined fragment to {@link CAUSE_BUDGET} chars, appending an
 *   ellipsis if targets were dropped or a lone head token was truncated.
 */
export const summarizeReadCause = (
  trace: readonly ReadSpanTrace[],
): string => {
  const seen = new Set<string>()
  const distinct: string[] = []
  for (let i = trace.length - 1; i >= 0; i--) {
    const token = displayTarget(trace[i])
    if (token.length === 0 || seen.has(token)) continue
    seen.add(token)
    distinct.push(token)
  }
  if (distinct.length === 0) return ''

  // A lone head token wider than the whole budget: hard-truncate it.
  // The trailing ellipsis already signals truncation, so any further
  // dropped targets need no second marker.
  if (distinct[0].length > CAUSE_BUDGET) {
    return `${distinct[0].slice(0, CAUSE_BUDGET - 1)}…`
  }

  const out: string[] = []
  let used = 0
  let dropped = false
  for (const token of distinct) {
    const sep = out.length === 0 ? 0 : 2 // ", "
    if (used + sep + token.length > CAUSE_BUDGET) {
      dropped = true
      break
    }
    out.push(token)
    used += sep + token.length
  }
  const joined = out.join(', ')
  return dropped ? `${joined}…` : joined
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
