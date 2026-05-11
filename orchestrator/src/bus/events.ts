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
