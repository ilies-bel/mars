import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { ensureInboxSchema, closeInboxRow } from './inbox.js';

async function makeClient(dir: string): Promise<Client> {
  const client = createClient({ url: `file:${join(dir, 'inbox.db')}` });
  return client;
}

async function rowCount(client: Client): Promise<number> {
  const r = await client.execute('SELECT COUNT(*) AS n FROM subscriber_stalls');
  return Number((r.rows[0] as unknown as { n: number | bigint }).n);
}

async function insertStallRow(
  client: Client,
  subscriberId: string,
  eventId: number,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO subscriber_stalls (subscriber_id, event_id, last_error) VALUES (?, ?, ?)`,
    args: [subscriberId, eventId, 'test-error'],
  });
}

describe('inbox', () => {
  let tmpDir: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-inbox-test-'));
    client = await makeClient(tmpDir);
    await ensureInboxSchema(client);
  });

  afterEach(async () => {
    client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ensureInboxSchema creates the subscriber_stalls table', async () => {
    // Insert a row to confirm the table exists and has the expected columns.
    await insertStallRow(client, 'sub-a', 1);
    expect(await rowCount(client)).toBe(1);
  });

  it('ensureInboxSchema is idempotent — calling it twice does not throw', async () => {
    await expect(ensureInboxSchema(client)).resolves.toBeUndefined();
  });

  it('closeInboxRow deletes the matching row', async () => {
    await insertStallRow(client, 'sub-b', 10);
    expect(await rowCount(client)).toBe(1);

    await closeInboxRow(client, 'sub-b', 10);

    expect(await rowCount(client)).toBe(0);
  });

  it('closeInboxRow is a no-op when the row does not exist', async () => {
    // No rows inserted — close should not throw.
    await expect(closeInboxRow(client, 'sub-c', 99)).resolves.toBeUndefined();
    expect(await rowCount(client)).toBe(0);
  });

  it('closeInboxRow only removes the targeted (subscriberId, eventId) pair', async () => {
    await insertStallRow(client, 'sub-d', 1);
    await insertStallRow(client, 'sub-d', 2);
    await insertStallRow(client, 'sub-e', 1);

    await closeInboxRow(client, 'sub-d', 1);

    // Only the (sub-d, 1) row is gone; the other two remain.
    expect(await rowCount(client)).toBe(2);
    const remaining = await client.execute(
      'SELECT subscriber_id, event_id FROM subscriber_stalls ORDER BY subscriber_id, event_id',
    );
    expect(remaining.rows).toHaveLength(2);
    expect(String(remaining.rows[0].subscriber_id)).toBe('sub-d');
    expect(Number(remaining.rows[0].event_id)).toBe(2);
    expect(String(remaining.rows[1].subscriber_id)).toBe('sub-e');
    expect(Number(remaining.rows[1].event_id)).toBe(1);
  });
});
