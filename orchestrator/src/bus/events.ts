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
  }),
  'task.blocked': z.object({
    taskId: z.string(),
    fixTaskId: z.string().nullable(),
    failureSignature: z.string(),
    failingStep: z.string(),
  }),
  'task.unblocked': z.object({
    taskId: z.string(),
    blockerTaskId: z.string(),
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
  // Schemas land ahead of writer conversion. Writers in queue.ts / inbox.ts /
  // ideas.ts / reflect-signals.ts must be wrapped in tx + publish() before
  // these become observable; tracked in a follow-up task.
  'transcript.appended': z.object({
    taskId: z.string(),
    role: z.string(),
    contentLength: z.number().int().nonnegative(),
  }),
  'inbox.raised': z.object({
    itemId: z.string(),
    kind: z.string(),
    category: z.string(),
    priority: z.string(),
    signature: z.string().nullable(),
  }),
  'inbox.resolved': z.object({
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
