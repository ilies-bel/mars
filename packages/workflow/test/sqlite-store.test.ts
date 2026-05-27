import { describe, it, expect } from 'vitest';
import { runWorkflow, SqliteStore } from '../src/index.js';
import type { WorkflowCtx } from '../src/index.js';

describe('SqliteStore (node:sqlite default impl)', () => {
  it('persists runs and steps and resumes across store instances on the same file', async () => {
    const path = `/tmp/mars-workflow-test-${process.pid}-${Date.now()}.db`;
    let codeCalls = 0;

    async function pipeline(ctx: WorkflowCtx): Promise<{ ok: boolean }> {
      await ctx.step('setup', () => 'wt', { sha: 'sha-1' });
      await ctx.step('code', () => {
        codeCalls += 1;
        return { lines: 3 };
      });
      await ctx.step('merge', () => true);
      return { ok: true };
    }

    const storeA = new SqliteStore(path);
    const first = await runWorkflow(pipeline, undefined, { store: storeA });
    expect(first.status).toBe('completed');
    expect(codeCalls).toBe(1);

    const steps = await storeA.listSteps(first.runId);
    expect(steps.map((s) => s.name)).toEqual(['setup', 'code', 'merge']);
    expect(steps[0].sha).toBe('sha-1');
    storeA.close();

    // Re-open the file in a fresh store and resume the same run id.
    const storeB = new SqliteStore(path);
    const second = await runWorkflow(pipeline, undefined, {
      store: storeB,
      runId: first.runId,
    });
    expect(second.status).toBe('completed');
    // Every step was already completed on disk — none re-ran.
    expect(codeCalls).toBe(1);

    const run = await storeB.getRun(first.runId);
    expect(run?.status).toBe('completed');
    storeB.close();
  });
});
