import { randomUUID } from 'node:crypto';
import { withTransaction, type DbClient, type DbTx } from '../core/lib/db.js';
import { EventMap, parseEvent, type EventName, type EventPayload } from './events.js';
import { buildEventInsert } from './publisher.js';
import {
  TRACE_EVENT_KINDS,
  deriveSeverity,
  type TraceEventKind,
  type TraceEventPhase,
  type TraceEventSeverity,
} from '../core/lib/trace-events-store.js';

/**
 * Unified typed emit surface (ADR "Every seam is a cordis service Port with
 * serializable contracts" / "One typed event…" — slice 1 of the modular-core
 * program).
 *
 * Reality check against the slicing brief: this codebase's "bus" is a
 * durable, poll-based Outbox (`events` table + per-Subscriber cursor in
 * `subscribers.ts` — `registerSubscriber` / `fetchPending`), not an
 * in-process `EventEmitter` with `.on()` listeners. There is a second,
 * independent durable log, `trace_events` (`core/lib/trace-events-store.ts`),
 * with its own closed kind vocabulary (`TRACE_EVENT_KINDS`) and no per-kind
 * payload schema. `emitEvent` below is the single write path that unifies
 * both: every emitted row lands in `trace_events` (the shared durable event
 * log every unified kind now shares), and when the kind is also a bus
 * `EventName` a second row lands in the `events` outbox so every existing
 * Outbox Subscriber keeps observing exactly what it observed before —
 * "bus `.on()` subscribers" from the brief, applied to this repo's actual
 * poll-based subscriber contract.
 */

/** Union of every registered event kind: the 39 bus kinds plus the 18 trace kinds. */
export type UnifiedEventKind = EventName | TraceEventKind;

/**
 * The payload type required for a given unified kind: the zod-inferred
 * shape for a bus `EventName`, or a free-form string-keyed record for a
 * trace-only kind (trace kinds have never had a per-kind payload schema —
 * see `TraceEventInput['payload']`).
 */
export type UnifiedEventPayload<K extends UnifiedEventKind> = K extends EventName
  ? EventPayload<K>
  : Record<string, unknown>;

export interface EmitEventOpts {
  /**
   * An already-open transaction to enlist in. When supplied, `emitEvent`
   * performs no BEGIN/COMMIT of its own — every row it writes uses this
   * executor, so a caller's state write and the emitted event(s) commit or
   * roll back together atomically.
   *
   * Omit to have `emitEvent` open and commit its own transaction.
   */
  tx?: DbTx;
  taskId?: string | null;
  originId?: string | null;
  phase?: TraceEventPhase | null;
  /** Overrides the derived severity. Trace-only kinds derive via `deriveSeverity`; bus-only kinds default to `'info'`. */
  severity?: TraceEventSeverity;
}

const BUS_EVENT_NAMES: ReadonlySet<string> = new Set(Object.keys(EventMap));
const TRACE_EVENT_KIND_SET: ReadonlySet<string> = new Set(TRACE_EVENT_KINDS);

function isBusEventName(kind: string): kind is EventName {
  return BUS_EVENT_NAMES.has(kind);
}

function isTraceEventKind(kind: string): kind is TraceEventKind {
  return TRACE_EVENT_KIND_SET.has(kind);
}

/**
 * True for any kind in the unified union (bus ∪ trace). Exported so the
 * completeness invariant ("no kind dropped") is directly testable against
 * both source registries without needing a valid payload for every schema.
 */
export function isUnifiedEventKind(value: string): value is UnifiedEventKind {
  return isBusEventName(value) || isTraceEventKind(value);
}

async function writeTraceRow(
  executor: DbTx,
  kind: string,
  severity: TraceEventSeverity,
  taskId: string | null,
  originId: string | null,
  phase: TraceEventPhase | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await executor.execute({
    sql: `INSERT INTO trace_events
          (id, timestamp, kind, severity, task_id, origin_id, phase, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [randomUUID(), Date.now(), kind, severity, taskId, originId, phase, JSON.stringify(payload)],
  });
}

/**
 * The single sanctioned write path for Mars operational history.
 *
 * Validates `payload`:
 * - Unknown `kind` (not in `EventMap` and not in `TRACE_EVENT_KINDS`) throws
 *   immediately, before any write is attempted. A `kind` string literal
 *   outside `UnifiedEventKind` is also a compile-time type error at the call
 *   site — the union is closed, same discipline as `EventMap`/`parseEvent`.
 * - A bus `EventName` kind is validated against its registered zod schema
 *   (`parseEvent`); a failing payload throws before any write.
 * - A trace-only kind has no per-kind schema (unchanged from
 *   `TraceEventStore.record`) — any string-keyed record is accepted.
 *
 * Persists one row to `trace_events` for every unified kind, plus a second
 * row to the `events` outbox when `kind` is also a bus `EventName` — so
 * existing durable Outbox Subscribers (`registerSubscriber` / `fetchPending`)
 * keep receiving every event they received before this surface existed.
 *
 * Pass `opts.tx` to enlist in a caller-supplied transaction so a state write
 * and this event land atomically; omit it to have `emitEvent` open and
 * commit its own transaction — in that case `client` is required. When
 * `opts.tx` is supplied, `client` is never touched (no transaction is opened)
 * and may be `null` — callers whose only client handle is behind an opaque
 * store seam (e.g. `TaskStore.atomic`'s `Scope`) don't need to reach for an
 * unrelated ambient client just to satisfy the parameter.
 */
export async function emitEvent<K extends UnifiedEventKind>(
  client: DbClient | null,
  kind: K,
  payload: UnifiedEventPayload<K>,
  opts: EmitEventOpts = {},
): Promise<void> {
  const kindStr: string = kind;
  const busKind = isBusEventName(kindStr) ? kindStr : null;
  const traceKind = isTraceEventKind(kindStr) ? kindStr : null;
  if (busKind === null && traceKind === null) {
    throw new Error(`emitEvent: unknown event kind '${kindStr}'`);
  }

  // parseEvent throws (ZodError) on a payload that fails the registered
  // schema — that rejection propagates before any row is written.
  const validated: Record<string, unknown> = busKind
    ? (parseEvent(busKind, payload) as Record<string, unknown>)
    : (payload as Record<string, unknown>);

  const severity: TraceEventSeverity =
    opts.severity ?? (traceKind ? deriveSeverity(traceKind, validated) : 'info');
  const taskId = opts.taskId ?? null;
  const originId = opts.originId ?? null;
  const phase = opts.phase ?? null;

  const run = async (tx: DbTx): Promise<void> => {
    await writeTraceRow(tx, kindStr, severity, taskId, originId, phase, validated);
    if (busKind) {
      await tx.execute(buildEventInsert(busKind, validated as EventPayload<EventName>));
    }
  };

  if (opts.tx) {
    await run(opts.tx);
    return;
  }
  if (!client) {
    throw new Error('emitEvent: client is required when opts.tx is not supplied');
  }
  await withTransaction(client, run);
}
