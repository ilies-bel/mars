import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../src/index.js';
import type { WorkflowCtx } from '../src/index.js';

describe('imperative workflow execution', () => {
  it('runs steps in source order and returns the projected output', async () => {
    const store = new InMemoryStore();
    const order: string[] = [];

    async function pipeline(ctx: WorkflowCtx, input: { n: number }): Promise<{ total: number }> {
      const a = await ctx.step('setup', () => {
        order.push('setup');
        return input.n;
      });
      const b = await ctx.step('code', () => {
        order.push('code');
        return a + 10;
      });
      const c = await ctx.step('merge', () => {
        order.push('merge');
        return b * 2;
      });
      return { total: c };
    }

    const result = await runWorkflow(pipeline, { n: 1 }, { store });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ total: 22 });
    expect(order).toEqual(['setup', 'code', 'merge']);

    const steps = await store.listSteps(result.runId);
    expect(steps.map((s) => s.name)).toEqual(['setup', 'code', 'merge']);
    expect(steps.every((s) => s.status === 'completed')).toBe(true);
  });
});
