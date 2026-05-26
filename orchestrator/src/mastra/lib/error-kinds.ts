/**
 * Error-kind registry — one entity per known recoverable error.
 *
 * Every kind of thing that can land in the inbox needing a human decision is
 * described here as a single self-contained entity bundling four facets:
 *
 *   - `kind`            — stable identifier, the address the rest of the system
 *                         dispatches on.
 *   - `trigger`         — how this error is detected / raised (human-readable).
 *   - `recipe`          — what it means and how to reason about it; the
 *                         diagnosis an operator (or agent) needs before acting.
 *   - `recoveryActions` — the menu of declarative actions that can resolve it.
 *
 * The registry is the single source of truth for "what can I do about this?".
 * It is deliberately pure, serialisable data with no runtime dependencies, so
 * the daemon can hand it to the read-only UI over the wire (`GET /error-kinds`)
 * and the UI can compose an action menu per inbox row without importing any
 * orchestrator code.
 *
 * Recovery actions are *descriptors*, not functions: `{ id, label, op }`. The
 * `op` names a verb the daemon already owns (an HTTP route on the local daemon
 * server). The clicker resolves `op` to that route; the daemon performs the
 * state transition. Behaviour lives in the daemon; this file only declares
 * intent.
 */

import type { DerivedInboxKind } from './derived-inbox'
import { DAEMON_KILLED_SIGNATURE } from './retry-budget'

/**
 * The verbs an action can ask the daemon to perform. Each maps to a route on
 * the daemon's local HTTP server (see `daemon/http-server.ts`).
 *
 * - `restart`                  — tear down the worktree/branch and re-queue
 *                                from setup (per-task). The "requeue a failed
 *                                task" verb.
 * - `unblock`                  — phantom-recover a blocked task: clear its
 *                                edges and flip it to failed so it can be
 *                                restarted or purged.
 * - `purge`                    — drop the task and its worktree permanently.
 * - `prune-worktree`           — remove a leftover worktree whose task is
 *                                terminal/absent.
 * - `restart-daemon`           — process-level: re-exec the daemon itself.
 * - `restart-all-daemon-killed`— batch: re-queue every failed task that carries
 *                                the daemon-killed signature in one request.
 * - `shape`                    — no daemon verb; a hint to run a skill
 *                                (`/mars:grill`). Rendered as guidance, not a
 *                                one-click button.
 */
export type ActionOp =
  | 'restart'
  | 'unblock'
  | 'purge'
  | 'prune-worktree'
  | 'restart-daemon'
  | 'restart-all-daemon-killed'
  | 'shape'

/**
 * A declarative recovery action. No executable code — the daemon owns the
 * behaviour behind `op`; this is the intent the UI renders and proxies.
 */
export interface ActionDescriptor {
  /** Stable id, unique within a kind's action list. */
  id: string
  /** Operator-facing button label. */
  label: string
  /** The daemon verb this action invokes. */
  op: ActionOp
  /**
   * When true, the UI must confirm before invoking (destructive or
   * process-level actions: purge, restart-daemon).
   */
  needsConfirm?: boolean
  /**
   * For `op: 'shape'` only — the skill/command the operator should run, since
   * there is no daemon verb to call. Ignored for every other op.
   */
  hint?: string
}

/**
 * One error kind: the error, its trigger, its recipe, and its recovery menu,
 * in a single entity.
 */
export interface ErrorKind {
  /** Stable identifier this kind dispatches on. */
  kind: ErrorKindId
  /** The derived-inbox row kind a matching row surfaces as. */
  rowKind: DerivedInboxKind
  /** How this error is detected / raised. */
  trigger: string
  /** What it means and how to reason about it before acting. */
  recipe: string
  /** The menu of actions that can resolve it. */
  recoveryActions: ActionDescriptor[]
}

/**
 * The closed set of error-kind keys. This is the single source of truth: the
 * `ErrorKindId` type, the registry, and the runtime guard all derive from it,
 * so no consumer can invent an off-list key. Each entry is a stable,
 * machine-readable identifier safe to persist, log, and put on the wire.
 *
 * These are a refinement of `DerivedInboxKind`: most map 1:1, but a single row
 * kind can fan out into several error kinds when the right recovery depends on
 * *why* the row appeared. `daemon-killed` is the motivating case — it is a
 * `failed-task` row, but a task SIGKILL'd with the daemon is far more likely to
 * just succeed on a fresh dispatch, so it earns its own key and a "requeue"
 * framing rather than the generic failure menu.
 */
export const ERROR_KIND_IDS = [
  'failed-task',
  'daemon-killed',
  'daemon-killed-batch',
  'stale-worktree',
  'draft-proposal',
] as const

export type ErrorKindId = (typeof ERROR_KIND_IDS)[number]

/** Runtime guard: narrow an untrusted value to a known error-kind key. */
export const isErrorKindId = (s: unknown): s is ErrorKindId =>
  ERROR_KIND_IDS.includes(s as ErrorKindId)

const ERROR_KINDS: Readonly<Record<ErrorKindId, ErrorKind>> = Object.freeze({
  'failed-task': {
    kind: 'failed-task',
    rowKind: 'failed-task',
    trigger:
      'A task ended in `failed` (or `dropped`) — its code, verify, or merge ' +
      'phase errored and recovery did not finish the work.',
    recipe:
      'Read the failure reason on the row. If the failure looks transient or ' +
      'the worktree is salvageable, restart it from scratch. If the work is no ' +
      'longer wanted, purge it to drop the task and its worktree.',
    recoveryActions: [
      { id: 'restart', label: 'Restart', op: 'restart' },
      { id: 'purge', label: 'Purge', op: 'purge', needsConfirm: true },
    ],
  },
  'daemon-killed': {
    kind: 'daemon-killed',
    rowKind: 'failed-task',
    trigger:
      'A task was in flight when the daemon was killed (`mars daemon kill` or ' +
      'an external SIGKILL). It is stamped `failureSignature: ' +
      `'${DAEMON_KILLED_SIGNATURE}'\` and left in \`failed\` — the daemon does ` +
      'NOT auto-requeue it; it raises this alert instead.',
    recipe:
      'This is not a task fault: the worker died with the daemon, not because ' +
      'the work was bad. A fresh dispatch is very likely to succeed. Requeue it ' +
      'now to re-run from setup, or restart the whole daemon if it is unhealthy.',
    recoveryActions: [
      { id: 'requeue', label: 'Requeue now', op: 'restart' },
      {
        id: 'restart-daemon',
        label: 'Restart daemon',
        op: 'restart-daemon',
        needsConfirm: true,
      },
    ],
  },
  'daemon-killed-batch': {
    kind: 'daemon-killed-batch',
    rowKind: 'failed-task',
    trigger:
      'Two or more tasks were in flight when the daemon was killed. Each carries ' +
      `\`failureSignature: '${DAEMON_KILLED_SIGNATURE}'\` and is left in \`failed\`. ` +
      'This batch affordance groups them so they can be re-queued in one click.',
    recipe:
      'None of these failures are task faults — the workers died with the daemon, ' +
      'not because the work was bad. A single batch restart re-queues every affected ' +
      'task from setup. Per-task "Requeue now" actions are still available on each ' +
      'individual alert for selective recovery.',
    recoveryActions: [
      {
        id: 'restart-all',
        label: 'Restart all daemon-killed',
        op: 'restart-all-daemon-killed',
      },
    ],
  },
  'stale-worktree': {
    kind: 'stale-worktree',
    rowKind: 'stale-worktree',
    trigger:
      'A `.mars/worktrees/<id>` directory exists but its task is terminal ' +
      '(done/dropped) or absent. A finished task should have removed its own ' +
      'worktree, so this is leftover state.',
    recipe:
      'Inspect the worktree if you want to recover anything from it, then prune ' +
      'it to reclaim the directory and its branch registration.',
    recoveryActions: [
      {
        id: 'prune',
        label: 'Prune worktree',
        op: 'prune-worktree',
        needsConfirm: true,
      },
    ],
  },
  'draft-proposal': {
    kind: 'draft-proposal',
    rowKind: 'draft-proposal',
    trigger: 'A proposal is sitting in `draft`, awaiting shaping into a PRD.',
    recipe:
      'Shaping a draft is a conversational step, not a daemon action. Run the ' +
      'grill skill in a Claude Code session to interview and synthesise the PRD.',
    recoveryActions: [
      {
        id: 'shape',
        label: 'Shape',
        op: 'shape',
        hint: '/mars:grill',
      },
    ],
  },
})

/** All error kinds, as a frozen list — the payload served over the wire. */
export const listErrorKinds = (): ErrorKind[] => Object.values(ERROR_KINDS)

/** Look up a single error kind by id. */
export const getErrorKind = (kind: ErrorKindId): ErrorKind => ERROR_KINDS[kind]

/**
 * Resolve the error kind for a derived-inbox row. A row's kind is not always
 * enough: a `failed-task` row whose task carries the daemon-killed signature
 * resolves to `daemon-killed` (a requeue-framed menu), not the generic
 * `failed-task` menu. Everything else maps straight from its row kind.
 */
export const errorKindForRow = (
  rowKind: DerivedInboxKind,
  failureSignature: string | null,
): ErrorKind => {
  if (rowKind === 'failed-task' && failureSignature === DAEMON_KILLED_SIGNATURE) {
    return ERROR_KINDS['daemon-killed']
  }
  return ERROR_KINDS[rowKind]
}
