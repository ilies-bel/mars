import type { ClaudeEvent } from './claude-stream'

/**
 * Implementor read/grep span watcher.
 *
 * Counts consecutive read-class tool calls (Read/Grep/Glob, and read-only
 * Bash commands matched by BASH_READ_PATTERN) emitted by the agent without
 * an interleaving action-class call (Edit/Write/NotebookEdit/MultiEdit, or
 * any Bash command that does not match BASH_READ_PATTERN). When the streak
 * first crosses the configured
 * limit, the watcher fires `onThreshold` exactly once so the caller can
 * emit a log line. The watcher does not abort, kill, or otherwise
 * interfere with the run — it is observational only.
 *
 * Tools outside both classes (TaskCreate, TodoWrite, WebFetch, etc.) are
 * ignored — they neither extend nor reset the streak. The watcher is
 * advisory and pure: it never mutates the conversation or queue.
 */
export interface ReadSpanWatcherConfig {
  /**
   * Streak length at which `onThreshold` fires. Default 5; overridable
   * per-call by the workflow. CLI/env tuning is exposed via
   * `MARS_READ_SPAN_LIMIT` (see {@link resolveReadSpanLimit}).
   */
  readonly limit: number
  /**
   * Invoked exactly once when the streak first reaches the limit. The
   * watcher keeps observing afterwards so the streak/trace stay current
   * for diagnostics, but `onThreshold` is not called again on the same
   * run (the streak must reset via an action-class call to re-arm).
   */
  onThreshold: (info: ThresholdInfo) => void
}

export interface ReadSpanTrace {
  readonly tool: 'Read' | 'Grep' | 'Glob' | 'Bash'
  readonly target: string
}

export interface ThresholdInfo {
  readonly limit: number
  readonly trace: readonly ReadSpanTrace[]
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const ACTION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
// Bash is handled separately — read-only commands extend the streak;
// action-class commands reset it. See BASH_READ_PATTERN below.

/**
 * Matches the leading command of a Bash invocation against known read-only
 * patterns. A Bash call is treated as read-class only when this pattern
 * matches AND the command does not contain an output redirect (`>`).
 */
export const BASH_READ_PATTERN =
  /^git\s+(?:status|log|diff|branch|show|rev-parse|rev-list|ls-files|remote|config\s+--get)|^(?:ls|cat|head|tail|wc|pwd|env|tree|find|stat|file)\b|^rg\b|^sqlite3\s+\S+\s+'?(?:SELECT|\.tables|\.schema)|^mars\s+(?:list|show|where|inbox|idea\s+(?:list|show))/

/** Output-redirect pattern — any command with this is write-class regardless of the leading command. */
const BASH_WRITE_REDIRECT = /\s>/

const isBashReadOnly = (command: string): boolean =>
  BASH_READ_PATTERN.test(command) && !BASH_WRITE_REDIRECT.test(command)

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
  /** Has the watcher already fired `onThreshold` for the current streak? */
  readonly thresholdReached: boolean
  /** Full read trace since the last action call. */
  readonly trace: readonly ReadSpanTrace[]
  /** Highest streak the watcher has ever seen across the whole run. */
  readonly maxStreak: number
  /** Total read-class tool uses observed (Read/Grep/Glob + read-only Bash). */
  readonly totalReads: number
  /** Total action-class tool uses observed (Edit/Write/MultiEdit/NotebookEdit + write Bash). */
  readonly totalActions: number
  /** True once the streak reached the limit at least once during the run. */
  readonly thresholdEverReached: boolean
}

export const createReadSpanWatcher = (
  config: ReadSpanWatcherConfig,
): ReadSpanWatcher => {
  let streak = 0
  let thresholdReached = false
  let thresholdEverReached = false
  let trace: ReadSpanTrace[] = []
  let maxStreak = 0
  let totalReads = 0
  let totalActions = 0
  const limit = config.limit

  const bumpRead = (entry: ReadSpanTrace): void => {
    streak += 1
    totalReads += 1
    if (streak > maxStreak) maxStreak = streak
    trace.push(entry)
    if (streak >= limit && !thresholdReached) {
      thresholdReached = true
      thresholdEverReached = true
      config.onThreshold({ limit, trace: [...trace] })
    }
  }

  const resetOnAction = (): void => {
    totalActions += 1
    streak = 0
    thresholdReached = false
    trace = []
  }

  return {
    get streak() {
      return streak
    },
    get thresholdReached() {
      return thresholdReached
    },
    get trace() {
      return trace
    },
    get maxStreak() {
      return maxStreak
    },
    get totalReads() {
      return totalReads
    },
    get totalActions() {
      return totalActions
    },
    get thresholdEverReached() {
      return thresholdEverReached
    },
    observe(event) {
      const uses = extractToolUses(event)
      if (uses.length === 0) return
      for (const use of uses) {
        if (READ_TOOLS.has(use.name)) {
          bumpRead({
            tool: use.name as 'Read' | 'Grep' | 'Glob',
            target: targetFromInput(use.input),
          })
        } else if (use.name === 'Bash') {
          const cmd =
            isRecord(use.input) && typeof use.input.command === 'string'
              ? use.input.command
              : ''
          if (isBashReadOnly(cmd)) {
            bumpRead({ tool: 'Bash', target: cmd.slice(0, 80) })
          } else {
            resetOnAction()
          }
        } else if (ACTION_TOOLS.has(use.name)) {
          resetOnAction()
        }
        // Other tools (TaskCreate, WebFetch, TodoWrite, etc.) are ignored
        // — they neither extend nor reset the streak.
      }
    },
  }
}
