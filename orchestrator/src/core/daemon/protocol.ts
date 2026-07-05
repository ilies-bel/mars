import type { Socket } from 'node:net'
import type { Author } from '../author'
import type { Task, TaskPlan, TaskTag, TaskSpec } from '../queue'
import type { RunInitOptions, RunInitResult } from '../../workflows/init-workflow'

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
  | { op: 'restart'; id: string }
  | { op: 'purge'; id: string; force?: boolean }
  | { op: 'arc-purge'; id: string; force?: boolean }
  | { op: 'drop'; id: string; force?: boolean }
  | { op: 'unblock'; id: string }
  | { op: 'block'; id: string; blockerIds: readonly string[] }
  | { op: 'remove-blockers'; id: string; blockerIds: readonly string[] }
  | { op: 'recover'; id?: string }
  | { op: 'proposal.promote'; proposalId: string }
  | { op: 'proposal.slice'; proposalId: string }
  | { op: 'proposal.approve'; proposalId: string }
  | { op: 'proposal.reslice'; proposalId: string; feedback: string }
  | { op: 'refine'; id: string; refresh?: boolean }
  | {
      op: 'glossary-write'
      kind: 'set' | 'remove'
      term: string
      definition?: string
      aliases?: readonly string[]
    }
  | { op: 'adr-add'; title: string; body: string }
  | { op: 'init'; opts: RunInitOptions }
  | { op: 'status' }
  | { op: 'reload-config' }
  | { op: 'set-flag'; flag: string; value: string }
  | { op: 'sync' }
  | { op: 'shutdown'; force?: boolean; drain?: boolean }
  | { op: 'kill' }
  | { op: 'ping' }
  | { op: 'investigate'; id: string }
  | { op: 'diagnose-failure'; id: string }
  | { op: 'attach'; id: string; leaseOwner: string }
  | { op: 'release-lease'; id: string; abort?: boolean }
  | { op: 'pause' }
  | { op: 'resume' }
  | { op: 'task.note'; id: string; body: string; author?: string }
  | { op: 'task.check'; id: string; criterionIndex: number; uncheck?: boolean; author?: string }

export type DaemonResponse =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; errorCode?: string }

export type InitResponseData = RunInitResult

export interface DaemonStatusPayload {
  pid: number
  startedAt: string
  inFlight: ReadonlyArray<{
    taskId: string
    kind: 'triage' | 'implement' | 'refine' | 'glossary-write' | 'adr-add'
  }>
  counts: { draft: number; queued: number; running: number; verifying: number; merging: number; 'vega-reconciling': number }
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
   * True when the operator has called `mars daemon pause` and the dispatch
   * loop is suspended. In-flight tasks continue; no new work is dispatched.
   * Cleared by `mars daemon resume`. Does NOT survive a daemon restart.
   */
  isPaused: boolean
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
