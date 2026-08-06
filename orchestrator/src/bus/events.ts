import { z } from 'zod';

/**
 * Single source of truth for every event type the bus knows about.
 *
 * Adding a new event type: append a new key here with its zod schema.
 * Nothing else in the bus needs to change — `EventName`, `EventPayload`,
 * `parseEvent`, and the typed publisher/client all derive from this object.
 */
export const EventMap = {
  'task.created': z.object({
    taskId: z.string(),
    title: z.string(),
  }),
  'task.completed': z.object({
    taskId: z.string(),
    result: z.unknown(),
  }),
  'task.failed': z.object({
    taskId: z.string(),
    error: z.string(),
    /**
     * Optional QA note from `mars release --abort <id> --note '<text>'`.
     * When present it is threaded into the recovery fix-task prompt under a
     * `## QA note` heading so the recovery agent sees the operator's feedback.
     */
    note: z.string().optional(),
    /**
     * The `<failingStep>/<error-class>` signature written to `failure_signature`
     * at failure time.  Carried in the event so the action-queue-repopulator
     * can read the signature even when the recovery-spawner's
     * `reopenTerminalTask` call has already NULLed the task-row field.
     */
    failureSignature: z.string().optional(),
  }),
  'verify-gate.quarantined': z.object({
    gateId: z.string(),
    originId: z.string(),
    failureSignature: z.string(),
    /** Captured output from the failing gate invocation, not a derived verdict. */
    failureEvidence: z.string().default('No captured gate output was available.'),
  }),
  'task.blocked': z.object({
    taskId: z.string(),
    fixTaskId: z.string().nullable(),
    failureSignature: z.string(),
    failingStep: z.string(),
    /**
     * The arc origin id for the blocked task. When present, the
     * action-queue-raiser keys the action-queue row on this value
     * (origin-fingerprint dedup) so all slices of the same arc collapse onto
     * a single action-queue item. Optional for backward compatibility — emit
     * sites that cannot cheaply resolve the origin omit this field; the
     * subscriber falls back to taskId.
     */
    originId: z.string().optional(),
  }),
  'task.unblocked': z.object({
    taskId: z.string(),
    /** The blocker that completed, or undefined when unblocked via edge removal. */
    blockerTaskId: z.string().optional(),
  }),
  'task.queued': z.object({
    taskId: z.string(),
  }),
  'task.added': z.object({
    taskId: z.string(),
  }),
  'task.refine': z.object({
    taskId: z.string(),
    refresh: z.boolean(),
  }),
  'task.dropped': z.object({
    taskId: z.string(),
    dropReason: z.string(),
  }),
  // Single terminal event fired alongside the discrete done/dropped/failed
  // event, in the same transaction. The Invalidator (alert-dismisser)
  // subscribes to this and closes Action-queue rows for the task on
  // reason ∈ {done, dropped, purged}, never `failed` (ADR-0028). `purged`
  // is emitted by dropTask before the row is deleted so a removed task
  // still produces a terminal event the closer can consume (ADR-0030).
  'task.terminal': z.object({
    taskId: z.string(),
    reason: z.enum(['done', 'dropped', 'failed', 'purged']),
  }),
  'task.priority_changed': z.object({
    taskId: z.string(),
    priority: z.number(),
  }),
  'task.blocker_added': z.object({
    taskId: z.string(),
    blockerTaskId: z.string(),
  }),
  'task.blocker_removed': z.object({
    taskId: z.string(),
    blockerTaskId: z.string(),
  }),
  // --- Phase 3 outbox events ---
  // Schemas land ahead of writer conversion. Writers in queue.ts / actionQueue.ts /
  // ideas.ts / reflect-signals.ts must be wrapped in tx + publish() before
  // these become observable; tracked in a follow-up task.
  'transcript.appended': z.object({
    taskId: z.string(),
    role: z.string(),
    contentLength: z.number().int().nonnegative(),
  }),
  'action-queue.raised': z.object({
    itemId: z.string(),
    kind: z.string(),
    category: z.string(),
    priority: z.string(),
    signature: z.string().nullable(),
  }),
  'action-queue.resolved': z.object({
    itemId: z.string(),
    fromState: z.string(),
    toState: z.string(),
    by: z.string(),
  }),
  'proposal.added': z.object({
    proposalId: z.string(),
    source: z.string(),
    title: z.string(),
  }),
  'proposal.updated': z.object({
    proposalId: z.string(),
    field: z.string(),
  }),
  'proposal.dismissed': z.object({
    proposalId: z.string(),
  }),
  'proposal.promoted': z.object({
    proposalId: z.string(),
  }),
  'proposal.sliced': z.object({
    proposalId: z.string(),
    taskCount: z.number().int().nonnegative(),
  }),
  'proposal.deleted': z.object({
    proposalId: z.string(),
  }),
  'proposal.story_added': z.object({
    proposalId: z.string(),
    position: z.number().int().nonnegative(),
  }),
  'proposal.story_removed': z.object({
    proposalId: z.string(),
    position: z.number().int().nonnegative(),
  }),
  'signal.recorded': z.object({
    taskId: z.string(),
    kind: z.string(),
  }),
  /**
   * Emitted when per-arc reflection lands a suggested Scorer (a per-Workflow
   * quality rubric awaiting operator triage). The action-queue-repopulator
   * converts this into a 'scorer-suggested' action-queue row keyed on the
   * scorer id, mirroring the proposal.added → draft-proposal projection.
   */
  'scorer.suggested': z.object({
    scorerId: z.string(),
    workflow: z.string(),
    title: z.string(),
  }),
  /**
   * Emitted when the operator accepts a suggested Scorer (`mars scorer
   * accept`). The repopulator evicts the 'scorer-suggested' row — the entity
   * left status='suggested', so the pure projection closes (ADR-0048).
   */
  'scorer.accepted': z.object({
    scorerId: z.string(),
  }),
  /**
   * Emitted when the operator dismisses a suggested Scorer (`mars scorer
   * dismiss`). Same eviction path as scorer.accepted.
   */
  'scorer.dismissed': z.object({
    scorerId: z.string(),
  }),
  /**
   * Emitted once when a durable Subscriber's handler has failed
   * STALL_THRESHOLD consecutive times on the same event id and its cursor
   * is blocked (ADR-0032). Written to the Outbox alongside the stall row.
   */
  'subscriber.stalled': z.object({
    subscriberId: z.string(),
    eventId: z.number().int(),
    lastError: z.string(),
  }),
  /**
   * Emitted when a previously-stalled Subscriber successfully processes the
   * event it was blocked on. The Invalidator subscriber reacts to this event
   * to close the corresponding `subscriber_stalls` stall row.
   */
  'subscriber.unstalled': z.object({
    subscriberId: z.string(),
    eventId: z.number().int(),
  }),
  /**
   * Emitted when a coder surfaces a question to the operator during task
   * execution. The question-raise Outbox Subscriber converts this event into
   * a durable action-queue item so a daemon restart between the event
   * write and the action-queue raise cannot lose the question.
   */
  'task.question': z.object({
    taskId: z.string(),
    question: z.string(),
  }),
  /**
   * Emitted when an operator clicks Investigate on a stale-worktree alert.
   * The task status flips to 'under_investigation' in the same write-tx so
   * the Invalidator (alert-dismisser) can subscribe here to resolve the open
   * action-queue row — the alert disappears immediately from the queue.
   * If the stale-worktree sweep later finds the worktree still stale it
   * calls raiseActionQueueItem, which creates a FRESH open row (de-duped only on
   * state='open'). Payload mirrors task.queued (ADR-0027/0030).
   */
  'task.under_investigation': z.object({
    taskId: z.string(),
  }),
  /**
   * Emitted by the daemon when the implement dispatch queue has been
   * backlogged (pending > cap × 0.75) for longer than the sustained window.
   * The steward-runtime-tune subscriber reacts by autonomously bumping the
   * implement semaphore cap and posting an acknowledgment chat message.
   */
  'kpi.backlog.degraded': z.object({
    pending: z.number().int().nonnegative(),
    cap: z.number().int().positive(),
    sustainedMs: z.number().nonnegative(),
  }),
  /**
   * Emitted when the recipe dispatcher auto-applies a taught recipe to a
   * fresh failure occurrence. The UI hero-delta builder surfaces this as a
   * 🤖 feed line explaining what fired and on which task.
   */
  'recipe-autorun': z.object({
    recipeId: z.string(),
    failureKind: z.string(),
    targetTaskId: z.string(),
    at: z.string(),
  }),
  /**
   * Emitted once per away→present transition detected by `recordPing`. The
   * away-digest subscriber reacts to this event by composing a narration
   * digest for the span and writing one `main_thread_entries` row.
   *
   * `transitionId` is the `presence_transitions.id` for this span.
   * `fromMs` / `toMs` are the bounding last-seen timestamps (epoch ms) that
   * define the away span: events that landed between them are narrated.
   */
  'presence.transition': z.object({
    transitionId: z.number().int(),
    fromMs: z.number().int(),
    toMs: z.number().int(),
  }),
} as const;

/** Union of every registered event type name. */
export type EventName = keyof typeof EventMap;

/** The validated payload type for a given event name. */
export type EventPayload<T extends EventName> = z.infer<(typeof EventMap)[T]>;

/** A fully-formed event as it appears on the wire and in the outbox. */
export interface BusEvent<T extends EventName = EventName> {
  id: number;
  type: T;
  payload: EventPayload<T>;
  ts: number;
}

/**
 * Validate a raw payload (typically from JSON) against the registered
 * schema for `type`. Throws if the type is unknown or the payload is invalid.
 */
export function parseEvent<T extends EventName>(
  type: T,
  rawPayload: unknown,
): EventPayload<T> {
  const schema = EventMap[type];
  if (!schema) {
    throw new Error(`Unknown event type: ${String(type)}`);
  }
  return schema.parse(rawPayload) as EventPayload<T>;
}

/** Type guard for runtime strings that should narrow to `EventName`. */
export function isEventName(s: string): s is EventName {
  return Object.prototype.hasOwnProperty.call(EventMap, s);
}
