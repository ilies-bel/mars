/**
 * deleteRun contract tests — exercised on both InMemoryStore and SqliteStore.
 *
 * A run that has putStep + setRunStatus applied and then deleteRun called must
 * leave getRun() === undefined and listSteps() === [] so the next createRun
 * with the same id starts from a blank slate (step 0, no prior checkpoints).
 */
import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '../src/store-memory.js';
import { SqliteStore } from '../src/store-sqlite.js';
import type { WorkflowStore } from '../src/store.js';

const NOW = 1_700_000_000_000;

/** Build a minimal RunRecord and two StepRecords in the store, then call deleteRun. */
async function seedThenDelete(store: WorkflowStore, runId: string): Promise<void> {
  await store.createRun({
    id: runId,
    workflowId: 'test-workflow',
    inputJson: '{}',
    status: 'running',
    createdAt: NOW,
    updatedAt: NOW,
  });

  await store.putStep({
    runId,
    name: 'setup-worktree',
    status: 'completed',
    sha: 'abc123',
    startedAt: NOW,
    finishedAt: NOW + 100,
    attempt: 1,
    summary: 'ok',
    errorSummary: null,
    transcriptKey: null,
    resultJson: '"done"',
  });

  await store.putStep({
    runId,
    name: 'run-claude-code',
    status: 'completed',
    sha: null,
    startedAt: NOW + 200,
    finishedAt: NOW + 5000,
    attempt: 1,
    summary: 'coded',
    errorSummary: null,
    transcriptKey: 'key-1',
    resultJson: '"done"',
  });

  await store.setRunStatus(runId, 'completed', NOW + 6000);

  // Sanity: both steps are visible before deletion.
  const stepsBefore = await store.listSteps(runId);
  expect(stepsBefore).toHaveLength(2);

  await store.deleteRun(runId);
}

describe('InMemoryStore.deleteRun', () => {
  it('removes run and all step records so getRun() is undefined and listSteps() is []', async () => {
    const store = new InMemoryStore();
    const runId = 'mem-run-01';

    await seedThenDelete(store, runId);

    expect(await store.getRun(runId)).toBeUndefined();
    expect(await store.listSteps(runId)).toEqual([]);
  });

  it('is a no-op for a run that was never created', async () => {
    const store = new InMemoryStore();
    // Must not throw even if the run does not exist.
    await expect(store.deleteRun('nonexistent')).resolves.toBeUndefined();
  });

  it('allows createRun with the same id after deleteRun (starts fresh)', async () => {
    const store = new InMemoryStore();
    const runId = 'mem-run-02';

    await seedThenDelete(store, runId);

    // Re-create with the same id — should succeed and be visible.
    await store.createRun({
      id: runId,
      workflowId: 'test-workflow',
      inputJson: '{}',
      status: 'running',
      createdAt: NOW + 10000,
      updatedAt: NOW + 10000,
    });

    const run = await store.getRun(runId);
    expect(run).toBeDefined();
    expect(run?.status).toBe('running');
    // No leftover steps from the deleted run.
    expect(await store.listSteps(runId)).toEqual([]);
  });
});

describe('SqliteStore.deleteRun', () => {
  const dbPath = (): string =>
    `/tmp/mars-workflow-delete-run-${process.pid}-${Math.floor(Math.random() * 1e9)}.db`;

  it('removes run and all step records so getRun() is undefined and listSteps() is []', async () => {
    const store = new SqliteStore(dbPath());
    const runId = 'sqlite-run-01';

    try {
      await seedThenDelete(store, runId);

      expect(await store.getRun(runId)).toBeUndefined();
      expect(await store.listSteps(runId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('is a no-op for a run that was never created', async () => {
    const store = new SqliteStore(dbPath());
    try {
      await expect(store.deleteRun('nonexistent')).resolves.toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('allows createRun with the same id after deleteRun (starts fresh)', async () => {
    const store = new SqliteStore(dbPath());
    const runId = 'sqlite-run-02';

    try {
      await seedThenDelete(store, runId);

      await store.createRun({
        id: runId,
        workflowId: 'test-workflow',
        inputJson: '{}',
        status: 'running',
        createdAt: NOW + 10000,
        updatedAt: NOW + 10000,
      });

      const run = await store.getRun(runId);
      expect(run).toBeDefined();
      expect(run?.status).toBe('running');
      expect(await store.listSteps(runId)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
