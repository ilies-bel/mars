import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../src/index.js';
import type { WorkflowCtx } from '../src/index.js';

describe('failed step recording', () => {
  it("records status='failed' with a compact error summary", async () => {
    const store = new InMemoryStore();

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('setup', () => 'ok');
      await ctx.step('verify', () => {
        throw new Error('verification failed: 3 tests red');
      });
      await ctx.step('merge', () => 'never reached');
    }

    const result = await runWorkflow(pipeline, undefined, { store });

    expect(result.status).toBe('failed');
    expect(result.error?.message).toBe('verification failed: 3 tests red');

    const steps = await store.listSteps(result.runId);
    const verify = steps.find((s) => s.name === 'verify');
    expect(verify?.status).toBe('failed');
    expect(verify?.errorSummary).toBe('verification failed: 3 tests red');
    expect(verify?.summary).toBeNull();
    expect(verify?.finishedAt).not.toBeNull();

    // The step after the throw never recorded.
    expect(steps.find((s) => s.name === 'merge')).toBeUndefined();

    const run = await store.getRun(result.runId);
    expect(run?.status).toBe('failed');
  });
});
