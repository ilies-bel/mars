import { beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, type DbClient } from '../../core/lib/db.js';
import { getTestDb } from '../../../test/db-fixture.js';
import { EventMap } from '../events.js';
import { TRACE_EVENT_KINDS } from '../../core/lib/trace-events-store.js';
import { registerSubscriber, fetchPending } from '../subscribers.js';
import { emitEvent, isUnifiedEventKind } from '../emit.js';

async function traceRows(client: DbClient, kind: string) {
  const result = await client.execute({
    sql: 'SELECT kind, severity, task_id, origin_id, phase, payload FROM trace_events WHERE kind = ?',
    args: [kind],
  });
  return result.rows;
}

async function eventRows(client: DbClient, type: string) {
  const result = await client.execute({
    sql: 'SELECT type, payload FROM events WHERE type = ?',
    args: [type],
  });
  return result.rows;
}

describe('emitEvent', () => {
  let client: DbClient;

  beforeEach(async () => {
    client = await getTestDb();
  });

  describe('unified kind union', () => {
    it('accepts every registered bus EventName', () => {
      for (const key of Object.keys(EventMap)) {
        expect(isUnifiedEventKind(key)).toBe(true);
      }
    });

    it('accepts every registered TraceEventKind', () => {
      for (const kind of TRACE_EVENT_KINDS) {
        expect(isUnifiedEventKind(kind)).toBe(true);
      }
    });

    it('rejects a kind that is in neither registry', () => {
      expect(isUnifiedEventKind('totally.unknown.kind')).toBe(false);
    });
  });

  describe('validation', () => {
    it('rejects an unknown kind at runtime without writing any row', async () => {
      await expect(
        // @ts-expect-error — exercising the runtime guard for a kind outside the closed union.
        emitEvent(client, 'not.a.real.kind', {}),
      ).rejects.toThrow(/unknown event kind/);

      const result = await client.execute('SELECT COUNT(*) AS n FROM trace_events');
      expect(Number(result.rows[0].n)).toBe(0);
    });

    it('rejects a bus-kind payload that fails its zod schema, writing no row', async () => {
      await expect(
        emitEvent(
          client,
          'task.queued',
          // Wrong shape: taskId must be a string.
          { taskId: 123 } as unknown as { taskId: string },
        ),
      ).rejects.toThrow();

      expect(await traceRows(client, 'task.queued')).toHaveLength(0);
      expect(await eventRows(client, 'task.queued')).toHaveLength(0);
    });
  });

  describe('persistence — bus kind', () => {
    it('writes both a trace_events row and an events row', async () => {
      await emitEvent(client, 'task.queued', { taskId: 'task-1' });

      const trace = await traceRows(client, 'task.queued');
      expect(trace).toHaveLength(1);
      expect(JSON.parse(trace[0].payload as string)).toEqual({ taskId: 'task-1' });

      const evt = await eventRows(client, 'task.queued');
      expect(evt).toHaveLength(1);
      expect(JSON.parse(evt[0].payload as string)).toEqual({ taskId: 'task-1' });
    });

    it('carries taskId/originId/phase onto the trace_events row', async () => {
      await emitEvent(
        client,
        'task.queued',
        { taskId: 'task-2' },
        { taskId: 'task-2', originId: 'origin-2', phase: 'code' },
      );

      const trace = await traceRows(client, 'task.queued');
      expect(trace[0].task_id).toBe('task-2');
      expect(trace[0].origin_id).toBe('origin-2');
      expect(trace[0].phase).toBe('code');
    });
  });

  describe('persistence — trace-only kind', () => {
    it('writes a trace_events row and no events row (not a bus kind)', async () => {
      await emitEvent(client, 'tool_invoked', { exitCode: 0, cmd: 'echo hi' });

      const trace = await traceRows(client, 'tool_invoked');
      expect(trace).toHaveLength(1);
      expect(trace[0].severity).toBe('info');

      const evt = await eventRows(client, 'tool_invoked');
      expect(evt).toHaveLength(0);
    });

    it('derives severity via deriveSeverity for a trace-only kind', async () => {
      await emitEvent(client, 'worker-model-mismatch', { expected: 'a', actual: 'b' });

      const trace = await traceRows(client, 'worker-model-mismatch');
      expect(trace[0].severity).toBe('warn');
    });

    it('honours an explicit severity override', async () => {
      await emitEvent(client, 'tool_invoked', { exitCode: 1 }, { severity: 'info' });

      const trace = await traceRows(client, 'tool_invoked');
      expect(trace[0].severity).toBe('info');
    });
  });

  describe('transactional enlistment', () => {
    it('commits atomically with a caller state write when opts.tx is supplied', async () => {
      const now = new Date().toISOString();
      await withTransaction(client, async (tx) => {
        await emitEvent(client, 'task.queued', { taskId: 'tx-ok' }, { tx });
        await tx.execute({
          sql: `INSERT INTO tasks
                  (id, prompt, status, origin_id, recovery_spawned_count, created_at, updated_at)
                VALUES ('tx-ok', 'test task', 'queued', 'tx-ok', 0, ?, ?)`,
          args: [now, now],
        });
      });

      expect(await traceRows(client, 'task.queued')).toHaveLength(1);
      expect(await eventRows(client, 'task.queued')).toHaveLength(1);
      const taskResult = await client.execute(`SELECT id FROM tasks WHERE id = 'tx-ok'`);
      expect(taskResult.rows).toHaveLength(1);
    });

    it('leaves no row behind — trace_events, events, or state — when the enlisting transaction fails', async () => {
      const now = new Date().toISOString();
      await expect(
        withTransaction(client, async (tx) => {
          await emitEvent(client, 'task.queued', { taskId: 'tx-doomed' }, { tx });
          await tx.execute({
            sql: `INSERT INTO tasks
                    (id, prompt, status, origin_id, recovery_spawned_count, created_at, updated_at)
                  VALUES ('tx-doomed', 'test task', 'queued', 'tx-doomed', 0, ?, ?)`,
            args: [now, now],
          });
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      expect(await traceRows(client, 'task.queued')).toHaveLength(0);
      expect(await eventRows(client, 'task.queued')).toHaveLength(0);
      const taskResult = await client.execute(`SELECT id FROM tasks WHERE id = 'tx-doomed'`);
      expect(taskResult.rows).toHaveLength(0);
    });

    it('leaves no trace_events row behind for a trace-only kind either', async () => {
      await expect(
        withTransaction(client, async (tx) => {
          await emitEvent(client, 'tool_invoked', { exitCode: 0 }, { tx });
          throw new Error('force rollback');
        }),
      ).rejects.toThrow('force rollback');

      expect(await traceRows(client, 'tool_invoked')).toHaveLength(0);
    });
  });

  describe('existing Outbox Subscriber compatibility', () => {
    it('a Subscriber registered before the emit still observes it via fetchPending', async () => {
      await registerSubscriber(client, 'emit-test-subscriber', { replay: true });

      await emitEvent(client, 'task.added', { taskId: 'sub-1' });

      const pending = await fetchPending(client, 'emit-test-subscriber');
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe('task.added');
      expect(pending[0].payload).toEqual({ taskId: 'sub-1' });
    });
  });
});
