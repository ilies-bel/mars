import type { EventEmitter } from 'node:events';
import type { UnifiedEventKind } from './emit.js';
import type { ViewStreamHub, StreamChannel } from '../core/daemon/view/stream-hub.js';

/**
 * Derive SSE invalidation from event subscribers (modular-core program).
 *
 * Before this module, every write site that wanted the UI to refresh had to
 * remember to call `viewStreamHub.broadcast(<channel>)` by hand next to its
 * mutation (see the `bus.on('proposal.added', () => hub.broadcast('progress'))`
 * style wiring still present in `server.ts`). That hand-wiring is correct but
 * silent: a new event kind that nobody remembers to wire simply never
 * refreshes any UI surface, and nothing fails to say so.
 *
 * This module inverts that: {@link VIEW_CHANNEL_FOR} is a single table from
 * every {@link UnifiedEventKind} (the full bus ∪ trace union — see
 * `../bus/emit.ts`) to the {@link ViewChannel}s it should invalidate. Because
 * the table type is `Record<UnifiedEventKind, ...>`, adding a new kind to
 * `EventMap` or `TRACE_EVENT_KINDS` without adding a row here is a `tsc`
 * error, not a silently-missing broadcast.
 *
 * {@link registerViewInvalidation} is the one subscriber that reads this
 * table and wires it onto the daemon's in-process event bus (the same
 * `EventEmitter` the existing hand-wired `bus.on(...)` calls in
 * `server.ts` use — see `merge-worker.ts`/`phase-recovery.ts`/
 * `reconcilers.ts` for the same `bus: EventEmitter` convention). A kind
 * mapped to `[]` is a deliberate "no dedicated UI surface yet" decision,
 * not an oversight — the exhaustive type still forces that decision to be
 * made explicitly.
 */

/** Alias kept local to this module so callers don't need to reach into `view/stream-hub.ts` directly. */
export type ViewChannel = StreamChannel;

/**
 * Kind → channel(s) table. Exhaustive over {@link UnifiedEventKind}: a kind
 * added to `EventMap` (`../bus/events.ts`) or `TRACE_EVENT_KINDS`
 * (`../core/lib/trace-events-store.ts`) that is missing here fails `tsc`.
 */
export const VIEW_CHANNEL_FOR: Record<UnifiedEventKind, readonly ViewChannel[]> = {
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

  // --- Legacy trace-only duplicates (pre-ADR-0097 underscore-form kinds;
  // see the "shared shape" comment in ../bus/events.ts). Same real-world
  // occurrence as their dot-form counterparts above, so same channels. ---
  origin_created: ['tasks'],
  step_started: ['live-task'],
  step_ended: ['live-task', 'tasks'],
  task_blocked: ['tasks'],
  recovery_spawned: ['tasks', 'action-queue'],
  task_failed: ['tasks', 'progress'],

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

  // --- View-invalidation-only kinds: the manual-broadcast-removal sweep's
  // fallback for a call site with no pre-existing domain event to piggyback
  // on (dispatch resume/pause, signature-storm trip, gate-fix diagnosis,
  // chat streaming pings, and similar daemon-internal state changes with no
  // dedicated lifecycle kind). Each maps 1:1 onto the channel it replaced. ---
  'view.tasks-invalidated': ['tasks'],
  'view.action-queue-invalidated': ['action-queue'],
  'view.chat-invalidated': ['chat'],
  'view.progress-invalidated': ['progress'],
  'view.proposals-invalidated': ['proposals'],
  'view.kpis-invalidated': ['kpis'],
  'view.live-task-invalidated': ['live-task'],
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
  for (const kind of Object.keys(VIEW_CHANNEL_FOR) as UnifiedEventKind[]) {
    const channels = VIEW_CHANNEL_FOR[kind];
    if (channels.length === 0) continue;
    bus.on(kind, () => {
      for (const channel of channels) hub.broadcast(channel);
    });
  }
}
