import type { EventEmitter } from 'node:events';
import type { UnifiedEventKind } from './emit.js';
import type { ViewStreamHub, StreamChannel } from '../core/daemon/view/stream-hub.js';

/**
 * Derive SSE invalidation from event subscribers (modular-core program).
 *
 * Before this module, every write site that wanted the UI to refresh had to
 * remember to call `viewStreamHub.broadcast(<channel>)` by hand next to its
 * mutation — some ~76 such calls across `server.ts`, `http-server.ts`,
 * `chat-runner.ts` and `conversation-delivery.ts`. That hand-wiring is correct
 * but silent: a new event kind that nobody remembers to wire simply never
 * refreshes any UI surface, and nothing fails to say so.
 *
 * Those call sites are gone. `registerViewInvalidation` is now the only
 * broadcaster in the daemon, enforced by
 * `core/daemon/__tests__/no-manual-broadcast.test.ts`.
 *
 * This module inverts that: {@link VIEW_CHANNEL_FOR} is a single table from
 * every {@link UnifiedEventKind} (the full bus ∪ trace union — see
 * `../bus/emit.ts`) plus every {@link ViewInvalidationKind} to the
 * {@link ViewChannel}s it should invalidate. Because the table type is an
 * exhaustive `Record`, adding a new kind to `EventMap`, `TRACE_EVENT_KINDS`
 * or {@link VIEW_INVALIDATION_KINDS} without adding a row here is a `tsc`
 * error, not a silently-missing broadcast.
 *
 * {@link registerViewInvalidation} is the one subscriber that reads this
 * table and wires it onto the daemon's in-process event bus (the same
 * `EventEmitter` the `bus.on(...)` dispatch handlers in `server.ts` use —
 * see `merge-worker.ts`/`phase-recovery.ts`/`reconcilers.ts` for the same
 * `bus: EventEmitter` convention). A kind mapped to `[]` is a deliberate
 * "no dedicated UI surface yet" decision, not an oversight — the exhaustive
 * type still forces that decision to be made explicitly.
 */

/** Alias kept local to this module so callers don't need to reach into `view/stream-hub.ts` directly. */
export type ViewChannel = StreamChannel;

/**
 * Kinds that exist *only* to invalidate a view.
 *
 * Deliberately not part of `TRACE_EVENT_KINDS`: a trace kind is durable
 * operational history (`emitEvent` persists one `trace_events` row per kind,
 * and `/events?kind=` accepts the whole vocabulary). These are neither —
 * they are transient in-process pings on the daemon's `EventEmitter`, emitted
 * by a mutation that has no domain event of its own (a chat-thread rename, a
 * dispatch resume, a signature-storm trip). Registering them here rather than
 * in the trace vocabulary keeps "what Mars records" and "what refreshes the
 * UI" from bleeding into each other.
 *
 * Prefer a real domain event. Reach for one of these only when the mutation
 * genuinely has none.
 */
export const VIEW_INVALIDATION_KINDS = [
  'view.tasks-invalidated',
  'view.action-queue-invalidated',
  'view.chat-invalidated',
  'view.proposals-invalidated',
] as const;

export type ViewInvalidationKind = (typeof VIEW_INVALIDATION_KINDS)[number];

/**
 * The narrow slice of the daemon's `EventEmitter` a module needs in order to
 * ask for a view refresh. Injected (never imported) so modules outside
 * `core/daemon/` — `core/lib/conversation-delivery.ts`, for one — stay free of
 * any dependency on the daemon process while still being able to invalidate.
 */
export interface ViewInvalidationBus {
  emit(kind: ViewInvalidationKind): boolean;
}

/**
 * Kind → channel(s) table. Exhaustive over {@link UnifiedEventKind} plus
 * {@link ViewInvalidationKind}: a kind added to `EventMap`
 * (`../bus/events.ts`), `TRACE_EVENT_KINDS`
 * (`../core/lib/trace-events-store.ts`) or {@link VIEW_INVALIDATION_KINDS}
 * that is missing here fails `tsc`.
 */
export const VIEW_CHANNEL_FOR: Record<
  UnifiedEventKind | ViewInvalidationKind,
  readonly ViewChannel[]
> = {
  // --- Task lifecycle → the Kanban/task-list view, and 'progress' for the
  // subset that also move the dashboard's progress/burndown numbers. ---
  'task.created': ['tasks'],
  'task.added': ['tasks'],
  'task.queued': ['tasks', 'progress'],
  'task.completed': ['tasks', 'progress'],
  'task.failed': ['tasks', 'progress'],
  'task.blocked': ['tasks'],
  'task.unblocked': ['tasks'],
  'task.refine': ['tasks'],
  'task.dropped': ['tasks'],
  'task.terminal': ['tasks', 'progress'],
  'task.priority_changed': ['tasks'],
  'task.blocker_added': ['tasks'],
  'task.blocker_removed': ['tasks'],
  // A coder question becomes a durable action-queue row (question-raise
  // Outbox Subscriber) and is also worth surfacing in the chat feed.
  'task.question': ['action-queue', 'chat'],
  // Flips task status and resolves the stale-worktree action-queue row.
  'task.under_investigation': ['tasks', 'action-queue'],

  // --- Verify gate → the 'gate-broken' action-queue condition. ---
  'verify-gate.quarantined': ['action-queue'],

  // --- Live task transcript streaming. ---
  'transcript.appended': ['live-task'],

  // --- Action queue rows raised/resolved directly. ---
  'action-queue.raised': ['action-queue'],
  'action-queue.resolved': ['action-queue'],

  // --- Proposals: mirrors the existing hand-wired `bus.on('proposal.*', ...)`
  // block in server.ts, which broadcasts 'progress' for every proposal
  // lifecycle event. ---
  'proposal.added': ['progress'],
  'proposal.updated': ['progress'],
  'proposal.dismissed': ['progress'],
  'proposal.promoted': ['progress'],
  'proposal.sliced': ['progress'],
  'proposal.deleted': ['progress'],
  'proposal.story_added': ['progress'],
  'proposal.story_removed': ['progress'],

  // --- Signals: internal bookkeeping only, no dedicated UI surface yet. ---
  'signal.recorded': [],

  // --- Scorers surface as action-queue rows (scorer-suggested). ---
  'scorer.suggested': ['action-queue'],
  'scorer.accepted': ['action-queue'],
  'scorer.dismissed': ['action-queue'],

  // --- Subscriber stall/unstall drive the subscriber-stalled condition. ---
  'subscriber.stalled': ['action-queue'],
  'subscriber.unstalled': ['action-queue'],

  // --- Dashboard KPI tiles. ---
  'kpi.backlog.degraded': ['kpis'],

  // --- Recipe autorun / presence narration feed the chat/activity feed. ---
  'recipe-autorun': ['chat'],
  'presence.transition': ['chat'],

  // --- ADR-0097 unified trace/bus surface. ---
  'origin.created': ['tasks'],
  'recovery.spawned': ['tasks', 'action-queue'],
  'step.started': ['live-task'],
  'step.ended': ['live-task', 'tasks'],

  // --- Trace-only step-span kinds. The four underscore-form duplicates that
  // used to sit here alongside them were collapsed onto their dot-form
  // counterparts above (ADR-0097): one kind, one shape, one row per
  // occurrence. See the ADR-0097 note in ./events.ts. ---
  step_started: ['live-task'],
  step_ended: ['live-task', 'tasks'],

  // --- Remaining trace-only diagnostic kinds: no dedicated UI surface
  // today. Listed explicitly (rather than defaulted) so a future UI surface
  // is a one-line change here, not a rediscovery. ---
  tool_invoked: [],
  log_line: [],
  'worker-model-mismatch': [],
  'post-coder-commit': [],
  'cli-invocation': [],
  scorer_result: [],
  'distill.applied': [],
  'index-card.attached': [],
  'merge-idempotent-skip': [],
  'merge-heartbeat': ['live-task'],
  'code-retry-attempt': ['live-task'],
  'restart-checkpoint': [],
  // Each verify step's command/exit/output lands as it completes, so a live
  // task view refreshes gate-by-gate instead of only at step_ended.
  'verify.step.completed': ['live-task'],
  // Attribution is emitted once, before the provider CLI starts — the same
  // moment step_started fires, and onto the same surface.
  'worker.model.attributed': ['live-task'],

  // --- View-invalidation-only kinds (see VIEW_INVALIDATION_KINDS): the
  // fallback for a mutation with no domain event to piggyback on — dispatch
  // resume/pause, signature-storm trip, gate-fix diagnosis, chat-thread
  // rename/archive/delete. Each maps 1:1 onto the channel it names. ---
  'view.tasks-invalidated': ['tasks'],
  'view.action-queue-invalidated': ['action-queue'],
  'view.chat-invalidated': ['chat'],
  'view.proposals-invalidated': ['proposals'],
};

/**
 * Subscribe once to every {@link UnifiedEventKind} that maps to at least one
 * channel, broadcasting each mapped channel on `hub` whenever the daemon's
 * in-process event bus emits that kind. Kinds mapped to `[]` are skipped —
 * no listener is registered for them.
 *
 * Call once at daemon startup, right next to the `ViewStreamHub`
 * construction — see `startDaemon` in `server.ts`.
 */
export function registerViewInvalidation(bus: EventEmitter, hub: ViewStreamHub): void {
  for (const kind of Object.keys(VIEW_CHANNEL_FOR) as (UnifiedEventKind | ViewInvalidationKind)[]) {
    const channels = VIEW_CHANNEL_FOR[kind];
    if (channels.length === 0) continue;
    bus.on(kind, () => {
      for (const channel of channels) hub.broadcast(channel);
    });
  }
}
