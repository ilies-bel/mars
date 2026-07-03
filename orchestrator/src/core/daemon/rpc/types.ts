/**
 * The daemon RPC handler seam — the in-process mirror of the CLI Command seam
 * (ADR-0023) for the daemon's socket protocol.
 *
 * The unit of the seam is the LEAF: each `op` in {@link DaemonRequest} is one
 * {@link RpcHandler}, registered by its `op` in a flat path-keyed registry (see
 * `registry.ts`). The 27-case `switch (req.op)` that used to live inside the
 * ~3470-line `startDaemon` closure is now a `Map<op, RpcHandler>` plus a pure
 * dispatcher — the only way the protocol surface was ever exercised was by
 * spawning the daemon and driving a socket; each leaf is now independently
 * nameable and testable with an injected fake {@link DaemonDeps}.
 *
 * Per ADR-0024 the drain loop, the three dispatchers (triage/implement/refine),
 * the {@link TaskFlightTracker}, the semaphores, the bus, and the HTTP wiring
 * STAY inside `startDaemon`; they are not extracted. They reach each handler as
 * injected `deps`. A leaf's `run(req, deps)` does exactly what the matching
 * switch case did: it reads args off `req`, narrowed to the matching variant via
 * the `op` discriminant, and pulls capabilities from `deps`.
 *
 * The pragmatic seam: the named handler functions (`handleAdd`, `handlePurge`,
 * …) already close over `startDaemon`'s scope, so `DaemonDeps` carries those
 * functions themselves, plus the raw primitives the formerly-inline cases need
 * (semaphores for `reload-config`, the live `acceptingWork` accessors for
 * `shutdown`/`kill`, the daemon file paths for socket cleanup on `kill`, …).
 * No business logic is duplicated; the leaves are thin adapters from `req` to
 * the captured closure state.
 */

import type { Task } from '../../queue'
import type { Author } from '../../author'
import type { TaskPlan, TaskTag, TaskSpec } from '../../queue'
import type { EventEmitter } from 'node:events'
import type { RunInitOptions, RunInitResult } from '../../../workflows/init-workflow'
import type { DaemonRequest, DaemonResponse, DaemonStatusPayload } from '../protocol'
import type { TaskFlightTracker } from '../task-flight-tracker'
import type { Semaphore } from '../server'
import type { ContinueResult } from '../continue-task'
import type {
  DropTaskResult,
  UnblockTaskResult,
} from '../../queue'
import type { RecoverAllBlockedTasksResult } from '../../blocker-resolution'

/**
 * The live semaphore set as the RPC layer sees it. `reload-config` mutates the
 * caps on these objects via `setSemLimit`, so they must be the same object
 * references `startDaemon` and `drain` hold — not snapshots.
 *
 * `structuredWriteSem` is the single semaphore shared by the `glossary-write`
 * and `adr-add` dispatch kinds; `reload-config` updates it once via this
 * reference.
 */
export interface RpcSemaphores {
  implement: Semaphore
  triage: Semaphore
  refine: Semaphore
  structuredWrite: Semaphore
}

/**
 * The daemon file paths the `kill` leaf unlinks before tearing down the event
 * loop (socket, pid file, http-port file).
 */
export interface RpcDaemonPaths {
  socketPath: string
  pidFile: string
  httpPortFile: string
}

/**
 * The capabilities injected into every RPC leaf handler.
 *
 * The `handle*` members are the named handler functions `startDaemon` already
 * defines; each leaf's `run` is a thin adapter that unpacks `req` and calls the
 * matching one. The remaining members are the raw primitives the
 * formerly-inline cases (`task.priority`, `sync`, `reload-config`, `set-flag`,
 * `ping`, `investigate`, `diagnose-failure`, `shutdown`, `kill`) reach into.
 *
 * `acceptingWork` is exposed as live accessors — NOT a captured boolean
 * snapshot — because the flag mutates (drain, `shutdown`, `kill` all flip it)
 * and the work-spawning gate plus several handlers must read/write the live
 * value. `setAcceptingWork(false)` is what `shutdown drain` and `kill` call.
 */
export interface DaemonDeps {
  // ── ambient primitives ────────────────────────────────────────────────────
  /** The daemon's line logger (the `(line) => void` closure, not a Logger). */
  log: (line: string) => void
  bus: EventEmitter
  tracker: TaskFlightTracker
  sems: RpcSemaphores
  /** Read the LIVE `acceptingWork` flag (mutates over the daemon's life). */
  getAcceptingWork(): boolean
  /** Flip the LIVE `acceptingWork` flag (drain / shutdown / kill toggle it). */
  setAcceptingWork(value: boolean): void
  /** Kick the drain loop (reload-config raises caps then re-drains). */
  drain(): Promise<void>
  /** The daemon's graceful-exit routine (shutdown delegates to it). */
  shutdown(force?: boolean): Promise<void>
  /** Daemon socket/pid/http-port files, unlinked by `kill`. */
  paths: RpcDaemonPaths

  // ── named handler functions (already closing over startDaemon scope) ───────
  handleAdd(
    prompt: string,
    plan?: TaskPlan,
    skipTriage?: boolean,
    author?: Author,
    blockerIds?: readonly string[],
    priority?: number,
    tags?: TaskTag[],
    spec?: TaskSpec,
    intent?: string,
  ): Promise<Task>
  setTaskPriority(id: string, priority: number): Promise<Task>
  handleUpdate(id: string, patch: DaemonUpdatePatch): Promise<void>
  handleContinue(id: string): Promise<ContinueResult>
  handleRestart(id: string): Promise<void>
  handlePurge(id: string, force: boolean): Promise<void>
  handleArcPurge(
    id: string,
    force: boolean,
  ): Promise<{ purgedIds: string[]; originId: string }>
  handleDrop(
    id: string,
    force: boolean,
  ): Promise<DropTaskResult & { worktreeRemoved: boolean; branchDeleted: boolean }>
  handleUnblock(id: string): Promise<UnblockTaskResult>
  handleBlock(
    id: string,
    blockerIds: readonly string[],
  ): Promise<{ taskId: string; blockerIds: readonly string[] }>
  handleRemoveBlockers(
    id: string,
    blockerIds: readonly string[],
  ): Promise<{ taskId: string; removed: readonly string[] }>
  handleRecover(id?: string): Promise<RecoverAllBlockedTasksResult>
  runSync(): Promise<unknown>
  handleProposalPromote(
    proposalId: string,
  ): Promise<{ proposalId: string; status: string }>
  handleProposalSlice(
    proposalId: string,
  ): Promise<{ proposalId: string; status: string; taskIds: string[] }>
  handleProposalApprove(
    proposalId: string,
  ): Promise<{ proposalId: string; queuedCount: number; blockedCount: number }>
  handleProposalReslice(
    proposalId: string,
    feedback: string,
  ): Promise<{ proposalId: string; status: string; taskIds: string[] }>
  handleRefine(id: string, refresh: boolean): Promise<void>
  dispatchGlossaryWrite(req: {
    kind: 'set' | 'remove'
    term: string
    definition?: string
    aliases?: readonly string[]
  }): Promise<void>
  dispatchAdrAdd(req: { title: string; body: string }): Promise<void>
  handleInit(opts: RunInitOptions): Promise<RunInitResult>
  handleStatus(): Promise<DaemonStatusPayload>
  investigateWorktree(id: string): Promise<unknown>
  diagnoseFailure(id: string): Promise<unknown>
  handleAttach(
    id: string,
    leaseOwner: string,
  ): Promise<{
    worktreePath: string
    branch: string
    title: string
    doneCriteria: readonly string[]
  }>
  handleReleaseLease(id: string, abort: boolean): Promise<void>
}

/** The `patch` shape carried by the `update` op (matches protocol). */
export type DaemonUpdatePatch = Extract<
  DaemonRequest,
  { op: 'update' }
>['patch']

/**
 * A single invocable RPC leaf. `op` is the discriminant key it is registered
 * under; `run` narrows `req` to the matching variant internally and returns a
 * {@link DaemonResponse}. Mirrors {@link import('../../../cli/command').Command}.
 */
export interface RpcHandler {
  op: DaemonRequest['op']
  run(req: DaemonRequest, deps: DaemonDeps): Promise<DaemonResponse>
}
