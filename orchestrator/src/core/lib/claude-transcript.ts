/**
 * Reads Claude Code's on-disk JSONL transcripts.
 *
 * Claude Code persists every `claude -p` session as
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * where `<encoded-cwd>` is the launching cwd with every `/` replaced by
 * `-`. Mars records the per-task session-id history on
 * `tasks.claude_session_ids` (append-only JSON array; see
 * `claude-session-ids.ts`), and the worker process spawn cwd is the
 * task's worktree path (see implement-workflow.ts ~line 924).
 *
 * Combining the two:
 *   1. Read tasks.claude_session_ids → string[].
 *   2. Read tasks.worktree_path → absolute path of the worktree root.
 *   3. Encode the cwd by replacing every `/` with `-`.
 *   4. For each sessionId: ~/.claude/projects/<encoded>/<sessionId>.jsonl
 *
 * Slice J reads these directly. There is no fallback to mastra.db (the
 * file is deleted at orchestrator startup; see slice A) and no fallback
 * to the legacy `task_transcripts.conversation_json` blob (that writer
 * was retired in the @mars/workflow port; see PRD 436f14c7).
 */

import { access, stat } from 'node:fs/promises'
import { constants as fsConstants, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline'
import { getDefaultTaskStore } from '../store/task-store'
import { parseClaudeSessionIds } from './claude-session-ids'

/**
 * Resolved absolute path to one session's on-disk JSONL transcript.
 *
 * `exists` is computed at resolve time via `fs.access`. A `false` value
 * is normal: it just means the user cleaned `~/.claude/projects/`, the
 * session never wrote anything (very early failure), or the file was
 * rotated. Callers must treat missing transcripts as a degradation, not
 * an error.
 */
export interface TranscriptLocation {
  sessionId: string
  /** ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl */
  path: string
  /** True if the file is present on disk at resolve time. */
  exists: boolean
}

/** A single parsed JSONL event from a transcript file. */
export interface TranscriptEvent {
  /** The raw parsed JSON line — passthrough; downstream may narrow. */
  raw: unknown
  /** Line number in the source file (1-based). */
  line: number
  /**
   * Which session this event came from, as a 0-based index into
   * `tasks.claude_session_ids`. Single-file readers leave this 0.
   * Multi-session readers use it to attribute events across the arc.
   */
  sessionIndex: number
}

/**
 * Encode a launching cwd into the directory name Claude Code uses to
 * store its transcripts. The convention is "replace every `/` with `-`"
 * — applied to the absolute path verbatim, including the leading slash.
 *
 *   /Users/foo/bar    →  -Users-foo-bar
 *   /tmp/mars-x/y     →  -tmp-mars-x-y
 *
 * Claude does not collapse leading `--` for paths that begin with `//`,
 * nor does it special-case the root. We mirror its behaviour with a
 * pure character replacement.
 */
export const encodeClaudeCwd = (cwd: string): string => cwd.split('/').join('-')

const projectsDir = (home: string): string => resolvePath(home, '.claude', 'projects')

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

interface TaskRowForTranscript {
  worktreePath: string | null
  claudeSessionIds: string[]
}

const loadTaskRow = async (
  taskId: string,
): Promise<TaskRowForTranscript | null> => {
  const store = await getDefaultTaskStore()
  const r = await store.query({
    sql: `SELECT t.worktree_path,
  COALESCE(
    (SELECT json_group_array(session_id ORDER BY position)
       FROM task_claude_sessions WHERE task_id = t.id),
    '[]'
  ) AS claude_session_ids
FROM tasks t WHERE t.id = ?`,
    args: [taskId],
  })
  if (r.rows.length === 0) return null
  const row = r.rows[0] as unknown as Record<string, unknown>
  return {
    worktreePath: (row.worktree_path as string | null) ?? null,
    claudeSessionIds: parseClaudeSessionIds(row.claude_session_ids),
  }
}

/**
 * Resolve every session's transcript path for a task. Order is preserved
 * from `claude_session_ids` so callers iterating the result get the
 * origin run first, then any recovery run(s).
 *
 * Returns an empty array if the task has no session ids recorded or if
 * the worktree path is unknown (we cannot encode a cwd we do not have —
 * legacy rows with a null `worktree_path` therefore resolve to zero
 * locations, which the report surfaces as "no transcripts recorded for
 * this task").
 *
 * `homeDir` is injectable for tests. Production callers omit it and
 * resolve under `os.homedir()`.
 */
export const resolveTranscriptLocationsForTask = async (
  taskId: string,
  opts: { homeDir?: string } = {},
): Promise<TranscriptLocation[]> => {
  const row = await loadTaskRow(taskId)
  if (!row) return []
  if (row.claudeSessionIds.length === 0) return []
  if (row.worktreePath === null) return []

  const home = opts.homeDir ?? homedir()
  const encoded = encodeClaudeCwd(row.worktreePath)
  const sessionDir = resolvePath(projectsDir(home), encoded)

  const out: TranscriptLocation[] = []
  for (const sessionId of row.claudeSessionIds) {
    const path = resolvePath(sessionDir, `${sessionId}.jsonl`)
    out.push({
      sessionId,
      path,
      exists: await fileExists(path),
    })
  }
  return out
}

/**
 * Stream parsed events from a single transcript file.
 *
 * Malformed lines (invalid JSON, partial writes during a live session,
 * etc.) are skipped without throwing. The optional `onMalformed`
 * callback is fired once per bad line so callers can surface it; by
 * default they are silently dropped.
 *
 * If the file does not exist at the time we open it (race vs. resolve
 * time, or caller passed a stale path), this generator yields zero
 * events and returns — never throws.
 */
export const readTranscript = async function* (
  path: string,
  opts: { onMalformed?: (line: number, error: unknown) => void } = {},
): AsyncGenerator<TranscriptEvent> {
  // Skip silently if the file isn't there. A missing transcript is a
  // degraded but normal state — see the file header.
  try {
    await stat(path)
  } catch {
    return
  }

  const stream = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNo = 0
  try {
    for await (const rawLine of rl) {
      lineNo += 1
      const trimmed = rawLine.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (err) {
        if (opts.onMalformed) opts.onMalformed(lineNo, err)
        continue
      }
      yield { raw: parsed, line: lineNo, sessionIndex: 0 }
    }
  } finally {
    rl.close()
    stream.destroy()
  }
}

/**
 * Stream every transcript event for a task, in `claude_session_ids`
 * order. Sessions whose JSONL file is missing on disk are silently
 * skipped; the caller can still observe their absence via
 * {@link resolveTranscriptLocationsForTask}.
 *
 * Each yielded event carries `sessionIndex` — 0 for the first session
 * id on the task, 1 for the next, etc. — so consumers reasoning across
 * sessions can attribute events without re-resolving paths.
 */
export const readAllTranscriptsForTask = async function* (
  taskId: string,
  opts: { homeDir?: string } = {},
): AsyncGenerator<TranscriptEvent> {
  const locations = await resolveTranscriptLocationsForTask(taskId, opts)
  for (let i = 0; i < locations.length; i++) {
    const loc = locations[i]
    if (!loc.exists) continue
    for await (const event of readTranscript(loc.path)) {
      yield { ...event, sessionIndex: i }
    }
  }
}
