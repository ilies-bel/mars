#!/usr/bin/env tsx
/**
 * Long-running listener.
 *
 * Subscribes to `task.created`, simulates 1s of work, then in a single
 * transaction updates the task row to `done` and publishes
 * `task.completed`. Tracks the highest event id it has observed so a
 * crash + restart can call `bus.replay(lastSeenId)` to catch up.
 *
 * Run with: pnpm tsx examples/bus/agent-listener.ts
 */
import { connectBus } from '../../src/bus/client.js';
import { openDb } from '../../src/bus/db.js';
import { publish } from '../../src/bus/publisher.js';

const url = process.env.BUS_URL ?? 'ws://localhost:7777';
const db = openDb();

const bus = await connectBus({ url });
console.log(`listener: connected to ${url}`);

let lastSeenId = 0;
bus.on('*', (ev) => {
  if (ev.id > lastSeenId) lastSeenId = ev.id;
});

bus.on('task.created', async (payload) => {
  console.log(`listener: received task.created ${payload.taskId} "${payload.title}"`);
  await new Promise((r) => setTimeout(r, 1000));
  const tx = db.transaction(() => {
    db.prepare('UPDATE tasks SET status = ?, updated = unixepoch() WHERE id = ?').run(
      'done',
      payload.taskId,
    );
    publish(db, 'task.completed', { taskId: payload.taskId, result: { ok: true } });
  });
  tx();
  console.log(`listener: completed task ${payload.taskId}`);
});

console.log('listener: subscribed to task.created');

// Re-issue replay every time the underlying socket connects (including
// after a daemon restart) so we never lose events while the daemon was
// down. A real consumer would also persist `lastSeenId` to disk so a
// listener crash + restart catches up too.
bus.onConnect(() => {
  void bus.replay(lastSeenId);
});
void bus.replay(lastSeenId);

const shutdown = () => {
  console.log('listener: shutting down');
  bus.close();
  db.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
