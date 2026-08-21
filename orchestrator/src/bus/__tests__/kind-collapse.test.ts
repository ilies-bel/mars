import { beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../core/lib/db.js';
import { getTestDb } from '../../../test/db-fixture.js';
import { EventMap } from '../events.js';
import { TRACE_EVENT_KINDS, deriveSeverity } from '../../core/lib/trace-events-store.js';
import { emitEvent, isUnifiedEventKind } from '../emit.js';

/**
 * ADR-0097 kind collapse.
 *
 * Four kinds used to exist twice — once on the bus with a zod schema under a
 * dot-form name, once in the `trace_events` vocabulary with a free-form
 * payload under an underscore name. One real-world occurrence therefore
 * produced two rows in two shapes, and a consumer querying history had to
 * know both names.
 *
 * These tests pin the collapse: one canonical name, one schema, and exactly
 * one `trace_events` row per occurrence.
 */

/** dot-form canonical name → the underscore name it retired. */
const COLLAPSED_KINDS = [
  { canonical: 'origin.created', retired: 'origin_created' },
  { canonical: 'recovery.spawned', retired: 'recovery_spawned' },
  { canonical: 'task.blocked', retired: 'task_blocked' },
  { canonical: 'task.failed', retired: 'task_failed' },
] as const;

/** A schema-valid payload for each collapsed kind. */
const SAMPLE_PAYLOAD: Record<string, Record<string, unknown>> = {
  'origin.created': { taskId: 'task-1', originId: 'origin-1' },
  'recovery.spawned': {
    taskId: 'fix-1',
    sourceTaskId: 'task-1',
    originId: 'origin-1',
    recipe: 'main-commiter',
    dispatchPhase: 'merge',
  },
  'task.blocked': {
    taskId: 'task-1',
    fixTaskId: 'fix-1',
    failureSignature: 'merge/uncommitted-changes',
    failingStep: 'merge',
  },
  'task.failed': { taskId: 'task-1', error: 'boom' },
};

describe('ADR-0097 collapsed event kinds', () => {
  describe('one canonical name', () => {
    for (const { canonical, retired } of COLLAPSED_KINDS) {
      it(`'${retired}' is retired in favour of '${canonical}'`, () => {
        expect(isUnifiedEventKind(retired)).toBe(false);
        expect(isUnifiedEventKind(canonical)).toBe(true);

        expect(Object.keys(EventMap)).not.toContain(retired);
        expect(TRACE_EVENT_KINDS as readonly string[]).not.toContain(retired);
      });
    }
  });

  describe('one zod schema', () => {
    for (const { canonical } of COLLAPSED_KINDS) {
      it(`'${canonical}' is schema'd exactly once, by the bus registry`, () => {
        // The bus registry owns the single schema...
        expect(Object.keys(EventMap)).toContain(canonical);
        // ...while the trace vocabulary carries the same canonical NAME (so
        // the trace store can read the row) and no competing shape of its own.
        expect(TRACE_EVENT_KINDS as readonly string[]).toContain(canonical);
        expect(
          Object.keys(EventMap).filter((k) => k === canonical),
        ).toHaveLength(1);
      });
    }

    it('rejects a payload that does not match the single schema', async () => {
      const client = await getTestDb();
      await expect(
        emitEvent(
          client,
          'recovery.spawned',
          // dispatchPhase is a closed enum — 'reflect' is not a member.
          { ...SAMPLE_PAYLOAD['recovery.spawned'], dispatchPhase: 'reflect' } as never,
        ),
      ).rejects.toThrow();
    });
  });

  describe('severity survives the collapse', () => {
    it('keeps the derived severity that the retired trace kinds carried', () => {
      expect(deriveSeverity('task.failed', {})).toBe('error');
      expect(deriveSeverity('task.blocked', {})).toBe('warn');
      expect(deriveSeverity('recovery.spawned', {})).toBe('warn');
      expect(deriveSeverity('origin.created', {})).toBe('info');
    });
  });

  describe('one occurrence, one row', () => {
    let client: DbClient;

    beforeEach(async () => {
      client = await getTestDb();
    });

    for (const { canonical, retired } of COLLAPSED_KINDS) {
      it(`one '${canonical}' occurrence writes exactly one trace_events row`, async () => {
        await emitEvent(client, canonical, SAMPLE_PAYLOAD[canonical] as never, {
          taskId: 'task-1',
          originId: 'origin-1',
        });

        // The whole point: a consumer reading history sees ONE row for this
        // occurrence, not one per registry.
        const all = await client.execute('SELECT kind FROM trace_events');
        expect(all.rows.map((r) => (r as unknown as { kind: string }).kind)).toEqual([
          canonical,
        ]);

        // And nothing at all under the retired name.
        const stale = await client.execute({
          sql: 'SELECT COUNT(*) AS n FROM trace_events WHERE kind = ?',
          args: [retired],
        });
        expect(Number((stale.rows[0] as unknown as { n: number | string }).n)).toBe(0);
      });
    }
  });
});
