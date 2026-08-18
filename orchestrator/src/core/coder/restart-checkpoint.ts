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
interface CommitEntry {
  /** Full commit SHA. */
  sha: string
  /** First line of the commit message (subject). */
  subject: string
  /** Repository-relative paths touched by this commit. */
  files: string[]
}

/** The last failing verify run, as far as it could be reconstructed. */
interface LastVerify {
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
  /**
   * Commits already made on this branch since the merge-base with `main`,
   * newest-first (`git log` order).
   */
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
   * True when the task spec had at least one done-criterion (regardless of
   * how many remain). Used by the renderer to distinguish "all criteria met"
   * (hadDoneCriteria=true, outstandingCriteria=[]) from "no criteria at all"
   * (hadDoneCriteria=false), so the renderer can emit an empty-but-present
   * criteria header in the first case.
   */
  hadDoneCriteria: boolean
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
  hadDoneCriteria: z.boolean().default(false),
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
 * Render a {@link RestartCheckpoint} into a Markdown section suitable for
 * embedding in the coder's resume prompt.
 *
 * Produces a `## Restart checkpoint` section listing:
 *  - commits already on the branch (sha7 + subject),
 *  - changed paths (de-duplicated union of all commits),
 *  - outstanding done-criteria as a `- [ ]` checklist (header still
 *    emitted when `hadDoneCriteria` is true and all are met, so the coder
 *    can see the full spec was satisfied),
 *  - the last failing verify run as a fenced code block with command, exit
 *    code, failure signature, and tail output.
 *
 * Returns an empty string when the checkpoint has no commits, no changed
 * paths, no criteria, and no lastVerify — callers can skip injection in
 * that case. In practice the caller only invokes this when `isResume` is
 * true, so at least one of those will be populated.
 */
export function renderRestartCheckpoint(cp: RestartCheckpoint): string {
  const body: string[] = []

  if (cp.commits.length > 0) {
    const lines = cp.commits.map((c) => `  - \`${c.sha.slice(0, 7)}\` ${c.subject}`).join('\n')
    body.push(`### Commits already on this branch\n\n${lines}`)
  }

  if (cp.changedPaths.length > 0) {
    const lines = cp.changedPaths.map((p) => `  - ${p}`).join('\n')
    body.push(`### Files already changed\n\n${lines}`)
  }

  if (cp.hadDoneCriteria) {
    if (cp.outstandingCriteria.length > 0) {
      const lines = cp.outstandingCriteria.map((c) => `  - [ ] ${c}`).join('\n')
      body.push(`### Remaining acceptance criteria\n\n${lines}`)
    } else {
      body.push(`### Remaining acceptance criteria`)
    }
  }

  if (cp.lastVerify !== null) {
    const lv = cp.lastVerify
    const meta: string[] = []
    if (lv.command !== null) meta.push(`Command: \`${lv.command}\``)
    if (lv.exitCode !== null) meta.push(`Exit code: ${lv.exitCode}`)
    if (lv.signature !== null) meta.push(`Signature: \`${lv.signature}\``)
    const tailBlock =
      lv.tailOutput !== null
        ? `\n\n\`\`\`text\n${lv.tailOutput}\n\`\`\``
        : ''
    body.push(`### Last failing verify\n\n${meta.join('\n')}${tailBlock}`)
  }

  if (body.length === 0) return ''
  return `## Restart checkpoint (prior work already on this branch)\n\n${body.join('\n\n')}`
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
  const hadDoneCriteria = doneCriteria.length > 0
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
    hadDoneCriteria,
    lastVerify,
    diagnostics: {
      taskId,
      mergeBase,
      commitCount: commits.length,
      workflowState,
    },
  }
}
