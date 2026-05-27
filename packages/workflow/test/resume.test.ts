import { describe, it, expect, vi } from 'vitest';
import { runWorkflow, InMemoryStore } from '../src/index.js';
import type { WorkflowCtx } from '../src/index.js';

describe('checkpoint-resume', () => {
  it('does not re-invoke fn for a step already completed, and returns the recorded result', async () => {
    const store = new InMemoryStore();

    const setupSpy = vi.fn(() => ({ worktree: '/tmp/wt' }));
    const codeSpy = vi.fn(() => ({ sha: 'abc123' }));
    // `merge` throws on the FIRST run so the run fails after setup+code
    // complete; on the SECOND run setup+code must be skipped and merge runs.
    let mergeAttempts = 0;
    const mergeSpy = vi.fn(() => {
      mergeAttempts += 1;
      if (mergeAttempts === 1) throw new Error('merge boom');
      return { merged: true };
    });

    async function pipeline(ctx: WorkflowCtx): Promise<{ merged: boolean }> {
      const wt = await ctx.step('setup', setupSpy);
      const code = await ctx.step('code', codeSpy);
      expect(wt.worktree).toBe('/tmp/wt');
      expect(code.sha).toBe('abc123');
      const out = await ctx.step('merge', mergeSpy);
      return out;
    }

    const first = await runWorkflow(pipeline, undefined, { store });
    expect(first.status).toBe('failed');
    expect(setupSpy).toHaveBeenCalledTimes(1);
    expect(codeSpy).toHaveBeenCalledTimes(1);
    expect(mergeSpy).toHaveBeenCalledTimes(1);

    // Resume the SAME run id. Completed steps must not re-run.
    const second = await runWorkflow(pipeline, undefined, { store, runId: first.runId });
    expect(second.status).toBe('completed');
    expect(second.output).toEqual({ merged: true });

    // setup and code stayed at one invocation — they were skipped on resume.
    expect(setupSpy).toHaveBeenCalledTimes(1);
    expect(codeSpy).toHaveBeenCalledTimes(1);
    // merge was retried (attempt 2 succeeds).
    expect(mergeSpy).toHaveBeenCalledTimes(2);

    const steps = await store.listSteps(second.runId);
    const merge = steps.find((s) => s.name === 'merge');
    expect(merge?.status).toBe('completed');
    expect(merge?.attempt).toBe(2);
  });

  it('returns the exact recorded result value on skip', async () => {
    const store = new InMemoryStore();
    const fn = vi.fn(() => ({ value: 42, label: 'cached' }));

    async function single(ctx: WorkflowCtx): Promise<{ value: number; label: string }> {
      return ctx.step('compute', fn);
    }

    const first = await runWorkflow(single, undefined, { store });
    expect(first.output).toEqual({ value: 42, label: 'cached' });
    expect(fn).toHaveBeenCalledTimes(1);

    const second = await runWorkflow(single, undefined, { store, runId: first.runId });
    expect(second.output).toEqual({ value: 42, label: 'cached' });
    // Skipped on resume — fn not called again.
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
