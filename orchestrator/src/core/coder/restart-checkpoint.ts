/**
 * Compact structured checkpoint for resumed coder sessions.
 *
 * This module is the **shared contract** and **composer** for the restart
 * checkpoint:
 *
 *   1. **"Inject restart checkpoint into resumed coder brief"** — builds a
 *      {@link RestartCheckpoint} from live worktree state (git log, changed
 *      files, acceptance status, last verify output) and injects the rendered
 *      form into the resume banner so the coder sees prior progress in a
 *      structured, scannable form instead of having to parse `git log -p`.
 *
 *   2. **"Trace restart-checkpoint payload for operator observability"** —
 *      emits a {@link RESTART_CHECKPOINT_KIND} trace event with the same
 *      payload so operators can inspect what context a resumed coder received.
 *
 * Both consumers import types and helpers from this module; this module has
 * no imports from consumer modules to avoid circular dependencies.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Task } from '../queue.js'
import { getTranscript, resolveQueueClient } from '../queue.js'

const execFileAsync = promisify(execFile)

/** Maximum bytes of verify output included in the checkpoint. */
const TAIL_OUTPUT_CAP = 4096

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One commit the coder already made on the task branch. */
export interface CommitEntry {
  /** Full commit SHA. */
  sha: string
  /** First line of the commit message (subject). */
  subject: string
  /** Repository-relative paths touched by this commit. */
  files: string[]
}

/** The last failing verify run, as far as it could be reconstructed. */
export interface LastVerify {
  /** The verify command that failed, or null if not recorded. */
  command: string | null
  /** Process exit code, or null when not captured. */
  exitCode: number | null
  /** Typed failure code (e.g. `verify:typecheck`), or null. */
  signature: string | null
  /** Last 4 KB of verify output, or null when unavailable. */
  tailOutput: string | null
}

/**
 * Compact structured checkpoint passed to a resumed coder session.
 *
 * Populated by {@link composeRestartCheckpoint} from live worktree state just
 * before the coder is launched; also emitted as a trace event payload for
 * operator observability.
 */
export interface RestartCheckpoint {
  /** Commits already made on this branch since the merge-base with `main`. */
  commits: CommitEntry[]
  /**
   * Repository-relative paths changed across all commits on the branch
   * (de-duplicated, sorted).
   */
  changedPaths: string[]
  /**
   * Done-criteria strings not yet marked `met`. Empty when no spec is
   * present or all criteria are met.
   */
  outstandingCriteria: string[]
  /**
   * The last failing verify run, or `null` if the coder is resuming after a
   * non-verify failure (e.g. a watchdog kill).
   */
  lastVerify: LastVerify | null
  /** Free-form composition diagnostics (task id, merge-base, counts). */
  diagnostics: Record<string, unknown>
}

export interface RestartCheckpointInput {
  taskId: string
  worktreePath: string
  task: Task
  workflowState?: unknown
}

// ---------------------------------------------------------------------------
// Zod schemas (validation + serialisation)
// ---------------------------------------------------------------------------

export const commitEntrySchema = z.object({
  sha: z.string(),
  subject: z.string(),
  files: z.array(z.string()),
})

export const lastVerifySchema = z.object({
  command: z.string().nullable(),
  exitCode: z.number().nullable(),
  signature: z.string().nullable(),
  tailOutput: z.string().nullable(),
})

/**
 * Zod schema for {@link RestartCheckpoint}. Used by both consumers: the
 * inject consumer validates the payload before embedding it in the brief;
 * the trace consumer validates before recording the event.
 */
export const restartCheckpointSchema = z.object({
  commits: z.array(commitEntrySchema),
  changedPaths: z.array(z.string()),
  outstandingCriteria: z.array(z.string()),
  lastVerify: lastVerifySchema.nullable(),
  diagnostics: z.record(z.string(), z.unknown()),
})

// ---------------------------------------------------------------------------
// Trace event kind
// ---------------------------------------------------------------------------

/**
 * Trace event kind emitted when a restart checkpoint is attached to a
 * resumed coder session.
 *
 * Add this literal to `TRACE_EVENT_KINDS` in `trace-events-store.ts` and
 * use this constant at the emit call site — avoid duplicating the string
 * to keep both sides in sync without a bidirectional import.
 */
export const RESTART_CHECKPOINT_KIND = 'restart-checkpoint' as const

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a {@link RestartCheckpoint} into Markdown suitable for embedding
 * in the coder's resume banner.
 *
 * The rendered block is injected between the "Prior progress is already in
 * this worktree" header and the verify-failure block (if any) — hence
 * {@link RestartCheckpoint.lastVerify} is deliberately not rendered here.
 *
 * Returns an empty string when all three rendered collections are empty (no
 * commits, no changed paths, no outstanding criteria) — callers can skip
 * injection in that case.
 */
export function renderRestartCheckpoint(cp: RestartCheckpoint): string {
  const parts: string[] = []

  if (cp.commits.length > 0) {
    const lines = cp.commits.map((c) => `  - \`${c.sha}\` ${c.subject}`).join('\n')
    parts.push(`### Commits already on this branch\n\n${lines}`)
  }

  if (cp.changedPaths.length > 0) {
    const lines = cp.changedPaths.map((p) => `  - ${p}`).join('\n')
    parts.push(`### Files already changed\n\n${lines}`)
  }

  if (cp.outstandingCriteria.length > 0) {
    const lines = cp.outstandingCriteria.map((c) => `  - [ ] ${c}`).join('\n')
    parts.push(`### Remaining acceptance criteria\n\n${lines}`)
  }

  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Compose a compact structured checkpoint for a resumed code step.
 *
 * Given a task id, its worktree path, and its current task record,
 * returns an immutable snapshot of:
 *  - commits already made on the task branch (sha + subject + changed paths),
 *  - the union of all paths touched so far,
 *  - acceptance criteria that have not yet been marked met,
 *  - the last failing verify command and its captured output (nullable).
 *
 * No worker is invoked; this is deterministic read-only composition.
 */
export async function composeRestartCheckpoint(
  input: RestartCheckpointInput,
): Promise<RestartCheckpoint> {
  const { taskId, worktreePath, task, workflowState } = input

  // ── 1. Merge-base ────────────────────────────────────────────────────────
  const { stdout: mbOut } = await execFileAsync('git', [
    '-C',
    worktreePath,
    'merge-base',
    'HEAD',
    'main',
  ])
  const mergeBase = mbOut.trim()

  // ── 2. Commits ───────────────────────────────────────────────────────────
  // Use a sentinel prefix so we can reliably split log output into per-commit
  // blocks even when subjects contain special characters.
  const { stdout: logOut } = await execFileAsync('git', [
    '-C',
    worktreePath,
    'log',
    `${mergeBase}..HEAD`,
    '--name-only',
    '--format=COMMITBEGIN%H\t%s',
  ])

  const commits: CommitEntry[] = []
  let current: CommitEntry | null = null
  for (const line of logOut.split('\n')) {
    if (line.startsWith('COMMITBEGIN')) {
      if (current !== null) commits.push(current)
      const rest = line.slice('COMMITBEGIN'.length)
      const tab = rest.indexOf('\t')
      current = {
        sha: tab >= 0 ? rest.slice(0, tab) : rest,
        subject: tab >= 0 ? rest.slice(tab + 1) : '',
        files: [],
      }
    } else if (line.trim() !== '' && current !== null) {
      current.files.push(line.trim())
    }
  }
  if (current !== null) commits.push(current)

  // ── 3. Changed paths ─────────────────────────────────────────────────────
  const changedPaths = [...new Set(commits.flatMap((c) => c.files))].sort()

  // ── 4. Outstanding criteria ───────────────────────────────────────────────
  const doneCriteria = task.spec?.doneCriteria ?? []
  let outstandingCriteria: string[]

  if (doneCriteria.length === 0) {
    outstandingCriteria = []
  } else {
    const r = await resolveQueueClient().execute({
      sql: `SELECT text, status FROM task_acceptance WHERE task_id = $1 ORDER BY position ASC`,
      args: [taskId],
    })
    if (r.rows.length === 0) {
      // No acceptance records yet — every criterion is still outstanding.
      outstandingCriteria = [...doneCriteria]
    } else {
      const met = new Set(
        (r.rows as Array<{ text: string; status: string }>)
          .filter((row) => row.status === 'met')
          .map((row) => row.text),
      )
      outstandingCriteria = doneCriteria.filter((c) => !met.has(c))
    }
  }

  // ── 5. Last verify failure ────────────────────────────────────────────────
  let lastVerify: LastVerify | null = null
  if (task.failedPhase === 'verify') {
    let tailOutput: string | null = null
    let exitCode: number | null = null

    // Primary source: verifyOutput recorded in trace_events via updateTask.
    const transcript = await getTranscript(taskId)
    if (transcript?.verifyOutput) {
      const raw = transcript.verifyOutput
      tailOutput = raw.length > TAIL_OUTPUT_CAP ? raw.slice(raw.length - TAIL_OUTPUT_CAP) : raw
    }

    // Fallback: stall diagnostics carry output tail + exit code for timed-out tasks.
    if (task.stallDiagnostics !== null) {
      try {
        const diag = JSON.parse(task.stallDiagnostics) as {
          outputTail?: string
          exitCode?: number
        }
        if (tailOutput === null && typeof diag.outputTail === 'string') {
          const raw = diag.outputTail
          tailOutput = raw.length > TAIL_OUTPUT_CAP ? raw.slice(raw.length - TAIL_OUTPUT_CAP) : raw
        }
        if (typeof diag.exitCode === 'number') {
          exitCode = diag.exitCode
        }
      } catch {
        // Ignore malformed JSON — diagnostics are best-effort.
      }
    }

    lastVerify = {
      command: task.spec?.verifyCmd ?? null,
      exitCode,
      signature: task.failureReasonCode ?? task.failureSignature ?? null,
      tailOutput,
    }
  }

  return {
    commits,
    changedPaths,
    outstandingCriteria,
    lastVerify,
    diagnostics: {
      taskId,
      mergeBase,
      commitCount: commits.length,
      workflowState,
    },
  }
}
