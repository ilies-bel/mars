import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DbClient } from '../../core/lib/db.js';
import { getTestDb } from '../../../test/db-fixture.js';
import { processedOnce } from '../processed-once.js';

async function countSideEffects(
  client: DbClient,
  subscriberId: string,
  eventId: number,
): Promise<number> {
  const result = await client.execute({
    sql:
      'SELECT COUNT(*) AS c FROM side_effects WHERE subscriber_id = ? AND event_id = ?',
    args: [subscriberId, eventId],
  });
  return Number(result.rows[0].c);
}

describe('processedOnce', () => {
  let client: DbClient;

  beforeEach(async () => {
    client = await getTestDb();
    // A toy "side effects" table acts as the observable boundary for the
    // tests — we count rows here rather than poking at the dedup table.
    await client.execute(`
      CREATE TABLE side_effects (
        id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        subscriber_id text   NOT NULL,
        event_id      bigint NOT NULL,
        note          text   NOT NULL
      )
    `);
  });

  afterEach(async () => {
    await client.execute('DROP TABLE side_effects');
  });

  it('runs the side effect exactly once across two invocations with the same eventId', async () => {
    const sub = 'sub-A';
    const eventId = 42;

    const sideEffect = async (tx: Parameters<
      Parameters<typeof processedOnce>[0]['sideEffect']
    >[0]) => {
      await tx.execute({
        sql:
          'INSERT INTO side_effects (subscriber_id, event_id, note) VALUES (?, ?, ?)',
        args: [sub, eventId, 'hello'],
      });
    };

    const first = await processedOnce({
      client,
      subscriberId: sub,
      eventId,
      sideEffect,
    });
    const second = await processedOnce({
      client,
      subscriberId: sub,
      eventId,
      sideEffect,
    });

    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(await countSideEffects(client, sub, eventId)).toBe(1);
  });

  it('leaves no dedup row when the side-effect transaction rolls back, so the next call re-runs', async () => {
    const sub = 'sub-A';
    const eventId = 7;

    // First call: throw inside the side effect — tx rolls back, dedup row
    // never lands.
    await expect(
      processedOnce({
        client,
        subscriberId: sub,
        eventId,
        sideEffect: async tx => {
          await tx.execute({
            sql:
              'INSERT INTO side_effects (subscriber_id, event_id, note) VALUES (?, ?, ?)',
            args: [sub, eventId, 'will be rolled back'],
          });
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');

    // Side effect must not be visible after rollback.
    expect(await countSideEffects(client, sub, eventId)).toBe(0);

    // Second call with a non-throwing side effect: handler must run.
    const result = await processedOnce({
      client,
      subscriberId: sub,
      eventId,
      sideEffect: async tx => {
        await tx.execute({
          sql:
            'INSERT INTO side_effects (subscriber_id, event_id, note) VALUES (?, ?, ?)',
          args: [sub, eventId, 'retry succeeded'],
        });
      },
    });

    expect(result.ran).toBe(true);
    expect(await countSideEffects(client, sub, eventId)).toBe(1);
  });

  it('scopes the dedup row per Subscriber: the same eventId observed by two different subscribers runs both handlers', async () => {
    const eventId = 99;

    const makeSE = (sub: string) => async (
      tx: Parameters<
        Parameters<typeof processedOnce>[0]['sideEffect']
      >[0],
    ) => {
      await tx.execute({
        sql:
          'INSERT INTO side_effects (subscriber_id, event_id, note) VALUES (?, ?, ?)',
        args: [sub, eventId, sub],
      });
    };

    const a = await processedOnce({
      client,
      subscriberId: 'sub-A',
      eventId,
      sideEffect: makeSE('sub-A'),
    });
    const b = await processedOnce({
      client,
      subscriberId: 'sub-B',
      eventId,
      sideEffect: makeSE('sub-B'),
    });

    expect(a.ran).toBe(true);
    expect(b.ran).toBe(true);
    expect(await countSideEffects(client, 'sub-A', eventId)).toBe(1);
    expect(await countSideEffects(client, 'sub-B', eventId)).toBe(1);
  });

  it('on replay after a crash between side-effect commit and cursor advance, observes the dedup row and skips the side effect', async () => {
    // Models the failure the helper is designed to defeat: the first call
    // commits both the dedup row and the side effect atomically, then the
    // daemon dies before any external cursor is advanced. On restart the
    // Subscriber replays the same (subscriberId, eventId) — the helper
    // must short-circuit so no second side effect is observed.
    const sub = 'sub-A';
    const eventId = 1234;

    const sideEffect = async (tx: Parameters<
      Parameters<typeof processedOnce>[0]['sideEffect']
    >[0]) => {
      await tx.execute({
        sql:
          'INSERT INTO side_effects (subscriber_id, event_id, note) VALUES (?, ?, ?)',
        args: [sub, eventId, 'committed'],
      });
    };

    const committed = await processedOnce({
      client,
      subscriberId: sub,
      eventId,
      sideEffect,
    });
    expect(committed.ran).toBe(true);
    expect(await countSideEffects(client, sub, eventId)).toBe(1);

    // Simulate replay after the cursor failed to advance.
    const replay = await processedOnce({
      client,
      subscriberId: sub,
      eventId,
      sideEffect,
    });
    expect(replay.ran).toBe(false);
    expect(await countSideEffects(client, sub, eventId)).toBe(1);
  });
});
