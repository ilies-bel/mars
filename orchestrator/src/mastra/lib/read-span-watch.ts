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
 *
 * A sibling detector tracks Agent/Explore sub-agent invocations: when the
 * sub-agent's return payload cites file paths and the coder subsequently
 * re-reads three or more of those paths (even interleaved with Bash or
 * other calls), the watcher fires `onRedundantSelfRead` exactly once with
 * a tag of 'redundant-self-read-after-subagent'. This detector is also
 * purely observational — it never aborts the run.
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
  /**
   * Hard-abort streak length. When set and the streak reaches this value,
   * `onAbort` is called exactly once (re-arms after an action-class reset).
   * Callers may use this to kill the run. Must be greater than `limit`
   * to be meaningful, but the watcher does not enforce ordering.
   */
  readonly abortLimit?: number
  /**
   * Invoked exactly once when the streak first reaches `abortLimit`. The
   * watcher keeps observing; the caller decides whether to abort.
   */
  onAbort?: (info: ThresholdInfo) => void
  /**
   * Optional. Invoked exactly once per sub-agent invocation when the coder
   * re-reads three or more paths that were cited in that sub-agent's return
   * payload. The call is tagged 'redundant-self-read-after-subagent' and is
   * purely informational — the watcher does not abort the run.
   */
  onRedundantSelfRead?: (info: RedundantSelfReadInfo) => void
}

/**
 * Payload delivered to `onRedundantSelfRead` when the watcher detects that
 * a coder has re-read three or more paths already cited by a sub-agent.
 */
export interface RedundantSelfReadInfo {
  /** The tool_use id of the Agent/Explore invocation whose report was cited. */
  readonly subAgentInvocationId: string
  /** File paths extracted from the sub-agent's return payload. */
  readonly citedPaths: readonly string[]
  /** Read targets that overlapped with `citedPaths`, in observation order. */
  readonly redundantReadPaths: readonly string[]
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
 *
 * Investigative shell commands (grep, fd, jq, awk, sed -n, rg, etc.) count
 * as discovery and extend the read streak. Prefix stripping via
 * {@link stripLeadingPrefixes} is applied before matching.
 */
export const BASH_READ_PATTERN =
  /^git\s+(?:status|log|diff|branch|show|rev-parse|rev-list|ls-files|remote|config\s+--get)|^(?:ls|cat|head|tail|wc|pwd|env|tree|find|stat|file|grep|fd|jq|awk)\b|^sed\s+-n\b|^rg\b|^sqlite3\s+\S+\s+'?(?:SELECT|\.tables|\.schema)|^mars\s+(?:list|show|where|inbox|idea\s+(?:list|show))/

/** Output-redirect pattern — any command with this is write-class regardless of the leading command. */
const BASH_WRITE_REDIRECT = /\s>/

/** Strips a leading `env KEY=VAL ` block (one or more key=value pairs). */
const ENV_PREFIX_RE = /^env\s+(?:\w+=\S+\s+)+/

/** Strips a leading `cd <path> && ` block. */
const CD_PREFIX_RE = /^cd\s+\S+\s+&&\s+/

/**
 * Strips leading `env KEY=VAL ` and `cd <path> && ` prefixes in a loop
 * until no more match. The result is the first "real" command in the chain.
 */
export const stripLeadingPrefixes = (command: string): string => {
  let cmd = command.trimStart()
  let changed = true
  while (changed) {
    changed = false
    const envMatch = ENV_PREFIX_RE.exec(cmd)
    if (envMatch) {
      cmd = cmd.slice(envMatch[0].length)
      changed = true
      continue
    }
    const cdMatch = CD_PREFIX_RE.exec(cmd)
    if (cdMatch) {
      cmd = cmd.slice(cdMatch[0].length)
      changed = true
    }
  }
  return cmd
}

const isBashReadOnly = (command: string): boolean => {
  if (BASH_WRITE_REDIRECT.test(command)) return false
  const stripped = stripLeadingPrefixes(command)
  return BASH_READ_PATTERN.test(stripped)
}

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
  readonly id: string
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
    out.push({
      id: typeof block.id === 'string' ? block.id : '',
      name: block.name,
      input: block.input,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Sub-agent result extraction helpers
// ---------------------------------------------------------------------------

interface ToolResultBlock {
  readonly toolUseId: string
  readonly text: string
}

const extractTextFromContent = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
  }
  return ''
}

const extractToolResults = (event: ClaudeEvent): ToolResultBlock[] => {
  if (event.type !== 'user') return []
  const message = (event as { message?: unknown }).message
  if (!isRecord(message)) return []
  const content = message.content
  if (!Array.isArray(content)) return []
  const out: ToolResultBlock[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== 'tool_result') continue
    if (typeof block.tool_use_id !== 'string') continue
    const text = extractTextFromContent(block.content)
    if (text.length > 0) {
      out.push({ toolUseId: block.tool_use_id, text })
    }
  }
  return out
}

/**
 * Extracts file-path-like tokens from a text blob. Matches bare filenames
 * (e.g. `queue.ts`, `implement-workflow.ts`) and relative/absolute paths
 * that end with a recognised source-file extension. Returns each unique
 * path once.
 */
const extractFilePaths = (text: string): string[] => {
  const found = new Set<string>()
  // Match tokens that look like file paths, preceded by whitespace/punctuation
  // or the start of string, and followed by whitespace/punctuation or end.
  const re =
    /(?:^|[\s"'`(,[\]{}])((?:\.\/|\/)?[-\w][-\w./]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yaml|yml|sh|py|go|rs|sql|txt|toml|lock))(?=[\s"'`),[\]{}.!?;:]|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[1]) found.add(m[1])
  }
  return [...found]
}

/**
 * Returns true when `readTarget` (a Read tool file_path) overlaps with one
 * of the `citedPaths` extracted from a sub-agent report. Handles the common
 * cases:
 * - exact match (`queue.ts` === `queue.ts`)
 * - absolute target vs bare cited name (`/a/b/queue.ts` ends with `/queue.ts`)
 * - bare target vs absolute cited path (`queue.ts` matches `/a/b/queue.ts`)
 */
const pathMatchesAny = (readTarget: string, citedPaths: readonly string[]): boolean =>
  citedPaths.some(
    (cited) =>
      readTarget === cited ||
      readTarget.endsWith('/' + cited) ||
      cited.endsWith('/' + readTarget),
  )

// ---------------------------------------------------------------------------
// Internal sub-agent tracking state
// ---------------------------------------------------------------------------

interface SubAgentTrack {
  readonly invocationId: string
  readonly citedPaths: readonly string[]
  readonly redundantReadPaths: string[]
  fired: boolean
}

/** Tool names that represent sub-agent dispatches worth tracking. */
const SUB_AGENT_TOOLS = new Set(['Agent', 'Explore'])

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

export const resolveReadSpanAbortLimit = (override?: number): number | undefined => {
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    return Math.floor(override)
  }
  const envRaw = process.env.MARS_READ_SPAN_ABORT_LIMIT
  if (envRaw !== undefined && envRaw.length > 0) {
    const n = Number(envRaw)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  return undefined
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
  /** Has the watcher already fired `onAbort` for the current streak? */
  readonly abortThresholdReached: boolean
}

export const createReadSpanWatcher = (
  config: ReadSpanWatcherConfig,
): ReadSpanWatcher => {
  let streak = 0
  let thresholdReached = false
  let thresholdEverReached = false
  let abortThresholdReached = false
  let trace: ReadSpanTrace[] = []
  let maxStreak = 0
  let totalReads = 0
  let totalActions = 0
  const limit = config.limit
  const abortLimit = config.abortLimit

  // Sub-agent tracking: pending invocations waiting for their tool_result,
  // and active tracks for which we're counting redundant reads.
  const pendingSubAgentIds = new Map<string, string>() // tool_use_id → agent name
  const activeSubAgentTracks: SubAgentTrack[] = []

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
    if (
      abortLimit !== undefined &&
      streak >= abortLimit &&
      !abortThresholdReached &&
      config.onAbort !== undefined
    ) {
      abortThresholdReached = true
      config.onAbort({ limit: abortLimit, trace: [...trace] })
    }
  }

  const resetOnAction = (): void => {
    totalActions += 1
    streak = 0
    thresholdReached = false
    abortThresholdReached = false
    trace = []
  }

  /**
   * After each Read tool_use, check whether the target overlaps with any
   * active sub-agent track. When a track accumulates 3+ overlapping reads,
   * fire `onRedundantSelfRead` exactly once.
   */
  const checkRedundantRead = (readTarget: string): void => {
    if (!config.onRedundantSelfRead) return
    for (const track of activeSubAgentTracks) {
      if (track.fired) continue
      if (pathMatchesAny(readTarget, track.citedPaths)) {
        track.redundantReadPaths.push(readTarget)
        if (track.redundantReadPaths.length >= 3) {
          track.fired = true
          config.onRedundantSelfRead({
            subAgentInvocationId: track.invocationId,
            citedPaths: track.citedPaths,
            redundantReadPaths: [...track.redundantReadPaths],
          })
        }
      }
    }
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
    get abortThresholdReached() {
      return abortThresholdReached
    },
    observe(event) {
      // Process user events: correlate tool_results to pending sub-agent
      // invocations and build active tracks from cited file paths.
      if (event.type === 'user') {
        const results = extractToolResults(event)
        for (const result of results) {
          const agentName = pendingSubAgentIds.get(result.toolUseId)
          if (agentName !== undefined) {
            pendingSubAgentIds.delete(result.toolUseId)
            const citedPaths = extractFilePaths(result.text)
            if (citedPaths.length > 0) {
              activeSubAgentTracks.push({
                invocationId: result.toolUseId,
                citedPaths,
                redundantReadPaths: [],
                fired: false,
              })
            }
          }
        }
      }

      const uses = extractToolUses(event)
      if (uses.length === 0) return
      for (const use of uses) {
        // Track sub-agent dispatches so we can correlate their results.
        if (SUB_AGENT_TOOLS.has(use.name) && use.id.length > 0) {
          pendingSubAgentIds.set(use.id, use.name)
        }

        if (READ_TOOLS.has(use.name)) {
          const target = targetFromInput(use.input)
          bumpRead({
            tool: use.name as 'Read' | 'Grep' | 'Glob',
            target,
          })
          // Only Read calls (not Grep/Glob) trigger the redundant-self-read
          // detector because those are the coder re-fetching full file content.
          if (use.name === 'Read') {
            checkRedundantRead(target)
          }
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
