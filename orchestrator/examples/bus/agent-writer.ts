#!/usr/bin/env tsx
/**
 * One-shot writer.
 *
 * In a single SQLite transaction:
 *   1. inserts a row into `tasks`
 *   2. publishes `task.created` to the outbox
 *
 * Run with: pnpm tsx examples/bus/agent-writer.ts
 */
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/bus/db.js';
import { publish } from '../../src/bus/publisher.js';

const db = openDb();
const taskId = randomUUID();
const title = `example task ${taskId.slice(0, 8)}`;

const tx = db.transaction(() => {
  db.prepare(
    'INSERT INTO tasks (id, status, payload) VALUES (?, ?, ?)',
  ).run(taskId, 'pending', JSON.stringify({ title }));
  publish(db, 'task.created', { taskId, title });
});
tx();

console.log(`writer: created task ${taskId} (${title})`);
db.close();
