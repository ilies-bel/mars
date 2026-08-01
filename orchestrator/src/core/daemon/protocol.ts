import type { Socket } from 'node:net'
import type { Author } from '../author'
import type { Task, TaskPlan, TaskTag, TaskSpec } from '../queue'
import type { RunInitOptions, RunInitResult } from '../../workflows/init-workflow'
import type { DispatchPauseState } from './pause-state'

export type DaemonRequest =
  | {
      op: 'add'
      prompt: string
      plan?: TaskPlan
      skipTriage?: boolean
      author?: Author
      blockerIds?: readonly string[]
      priority?: number
      tags?: TaskTag[]
      spec?: TaskSpec
      intent?: string
      /** Originating Claude Code session UUID (from CLAUDE_CODE_SESSION_ID). */
      originSessionId?: string | null
      /** Pipeline selection: `.mars/workflows/<workflow>-workflow.js`. */
      workflow?: string | null
      /**
       * Task id this new task supersedes. When present the new task is an
       * operator-authored continuation of a failed arc whose automatic recovery
       * exhausted all options. Validated by the CLI (task must exist and be in
       * status 'failed'); execution of the supersede sequence is a no-op stub
       * until a later slice wires it up.
       * TODO(supersede-execution): consumed by slice N of PRD 94e2a82a.
       */
      supersedes?: string
      /** QA mode for the review step: 'auto' (default) or 'manual'. */
      qa?: 'auto' | 'manual'
      /** When true, the usage-aware scheduler may defer this task. */
      deferrable?: boolean
    }
  | { op: 'task.priority'; id: string; priority: number }
  | {
      op: 'update'
      id: string
      patch: {
        status?: Task['status']
        plan?: TaskPlan | null
        branch?: string | null
        worktreePath?: string | null
        claudeSessionId?: string | null
        error?: string | null
      }
    }
  | { op: 'continue'; id: string }
  | { op: 'restart'; id: string; force?: boolean }
  | { op: 'remerge'; id: string }
  | { op: 'purge'; id: string; force?: boolean }
  | { op: 'arc-purge'; id: string; force?: boolean }
  | { op: 'drop'; id: string; force?: boolean }
  | { op: 'unblock'; id: string }
  | { op: 'block'; id: string; blockerIds: readonly string[] }
  | { op: 'remove-blockers'; id: string; blockerIds: readonly string[] }
  | { op: 'recover'; id?: string }
  | { op: 'proposal.promote'; proposalId: string; priority?: number }
  | { op: 'proposal.slice'; proposalId: string; priority?: number }
  | { op: 'proposal.approve'; proposalId: string }
  | { op: 'proposal.reslice'; proposalId: string; feedback: string; priority?: number }
  | { op: 'proposal.take'; proposalId: string; workflow?: string }
  | { op: 'refine'; id: string; refresh?: boolean }
  | {
      op: 'glossary-write'
      kind: 'set' | 'remove'
      term: string
      definition?: string
      aliases?: readonly string[]
      surfaceForms?: readonly string[]
    }
  | { op: 'adr-add'; title: string; body: string }
  | { op: 'init'; opts: RunInitOptions }
  | { op: 'status' }
  | { op: 'reload-config' }
  /**
   * Apply the `dispatch` control lever to the RUNNING daemon.
   *
   * `off` suspends dispatch with reason 'operator'; `on` resumes, clearing
   * whichever cause held the pause (operator / storm / quota) plus the durable
   * signature-storm `tripped` flag, so a later restart does not re-pause a
   * queue the operator deliberately resumed. Durability is the CLI's job:
   * `mars operator set dispatch` writes `paused` to daemon.json BEFORE sending
   * this, mirroring `operator set <lever>` → `apply-lever`.
   */
  | { op: 'set-dispatch'; value: 'on' | 'off' }
  | { op: 'sync' }
  | { op: 'shutdown'; force?: boolean; drain?: boolean }
  | { op: 'kill' }
  | { op: 'ping' }
  | { op: 'investigate'; id: string }
  | { op: 'diagnose-failure'; id: string }
  | { op: 'release-lease'; id: string; abort?: boolean; note?: string }
  // Complete the current manual step: re-queue for pipeline continuation but
  // KEEP the lease identity so the next manual park re-leases the same owner.
  | { op: 'step-done'; id: string }
  // Rewind a stuck task to an earlier named workflow step: clears the durable
  // checkpoint for `stepName` and every downstream step, clears stale failure
  // metadata, and re-queues (or restores blocked status) so the next dispatch
  // begins at `stepName`. Requires an idle, unleased task.
  | { op: 'step-reset'; id: string; stepName: string }
  | { op: 'task.note'; id: string; body: string; author?: string }
  | { op: 'task.check'; id: string; criterionIndex: number; uncheck?: boolean; author?: string }
  /** Append an evidence row for a mutation made through the worker MCP server. */
  | {
      op: 'mcp.audit.append'
      toolName: string
      taskId: string
      argsJson: Record<string, unknown>
      ok: boolean
      errorMessage: string | null
    }
  /**
   * Read the worker-safe context for a task. Returns only fields relevant to
   * the dispatched agent: id, title, prompt, files, verify cmd, done criteria
   * with check state, merge mode, status, and blocker ids. No internal counters,
   * auth tokens, or raw DB rows are returned.
   */
  | { op: 'task.contextForWorker'; id: string }
  // Preview-process management: spawn a detached stack process whose
  // stdout/stderr are teed to `.mars/previews/<taskId>.log`, query its
  // current status, or tear it down (SIGTERM → SIGKILL fallback).
  | { op: 'preview.spawn'; taskId: string; cmd: string; cwd: string }
  | { op: 'preview.status'; taskId: string }
  | { op: 'preview.teardown'; taskId: string }
  // Cancel an active merge job by id: marks it canceled in the DB and, if
  // the merge worker is currently processing it, aborts the per-job signal
  // so the merge operation is interrupted (slice-3 abort path).
  | { op: 'merge.cancel'; jobId: string }
  // Read the current dispatch spend-control levers from the DB.
  | { op: 'spend-control.show' }
  // Upsert one or more spend-control levers. Unspecified fields are unchanged.
  | {
      op: 'spend-control.set'
      patch: {
        perKindCeilings?: Record<string, number> | null
        pauseThresholdPct?: number
        resumeThresholdPct?: number
        suppressRecovery?: boolean
        rampBackStepPct?: number
      }
    }
  /** Apply a persisted control lever to the running daemon process env immediately. */
  | { op: 'apply-lever'; name: 'recovery' | 'scoring'; value: 'on' | 'off' }

export type DaemonResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; errorCode?: string }

export type InitResponseData = RunInitResult

export interface DaemonStatusPayload {
  pid: number
  startedAt: string
  inFlight: ReadonlyArray<{
    taskId: string
    kind: 'triage' | 'implement' | 'refine' | 'glossary-write' | 'adr-add' | 'arc-verify' | 'merge'
  }>
  counts: { draft: number; queued: number; running: number; verifying: number; merging: number; 'vega-reconciling': number }
  /**
   * The implement concurrency cap as configured on disk vs the cap the daemon
   * is actually enforcing. The Steward autotuner mutates the live semaphore
   * limit (it raises on sustained backlog, and holds when machine load is too
   * high), so the two can disagree — previously with nothing reporting it, and
   * an operator staring at `implement: 3` in `.mars/daemon.json` while the
   * daemon ran at 1. `reason` explains the divergence and is `null` when the
   * two agree.
   */
  implementCap: {
    configured: number
    effective: number
    reason: string | null
  }
  /**
   * Git HEAD SHA captured when the daemon process started (dev install only).
   * Null when the install is prod or when git was unavailable at startup.
   */
  sourceSha: string | null
  /**
   * Most-recently-sampled git HEAD SHA (updated by the periodic staleness
   * check). Null until the first successful check or when git is unavailable.
   */
  currentSha: string | null
  /**
   * True when the daemon is running source code from a commit that is no
   * longer HEAD — i.e. main has advanced since the daemon started. Always
   * false on prod installs and when either SHA is null.
   */
  isStale: boolean
  /**
   * The daemon's ONE dispatch-pause state, carrying the reason dispatch is
   * suspended ('operator' | 'storm' | 'quota') so status can say WHY rather
   * than just that it is paused. In-flight tasks continue; no new work is
   * dispatched. Cleared by `mars operator set dispatch on` — which also clears
   * the signature-storm breaker when that is what paused dispatch. A `storm`
   * pause is restored at startup from the durable breaker flag.
   */
  pause: DispatchPauseState
}

const NEWLINE = 0x0a

export const writeLine = (sock: Socket, payload: unknown): boolean => {
  const line = `${JSON.stringify(payload)}\n`
  return sock.write(line)
}

export const readLines = (
  sock: Socket,
  onLine: (line: string) => void,
): void => {
  const chunks: Buffer[] = []
  let length = 0
  sock.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
    length += chunk.length
    while (true) {
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length)
      if (chunks.length !== 1) {
        chunks.length = 0
        chunks.push(buf as Buffer)
      }
      const target = chunks[0] as Buffer
      const idx = target.indexOf(NEWLINE)
      if (idx === -1) return
      const line = target.subarray(0, idx).toString('utf8')
      const rest = target.subarray(idx + 1)
      chunks.length = 0
      length = rest.length
      if (rest.length > 0) chunks.push(rest)
      if (line.length > 0) onLine(line)
    }
  })
}
