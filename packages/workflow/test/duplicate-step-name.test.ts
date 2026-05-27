import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../src/index.js';
import type { WorkflowCtx } from '../src/index.js';

describe('duplicate step name rejection', () => {
  it('fails the run when the same step name is reached twice', async () => {
    const store = new InMemoryStore();

    async function dup(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('verify', () => 1);
      await ctx.step('verify', () => 2);
    }

    const result = await runWorkflow(dup, undefined, { store });

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('Duplicate step name "verify"');
  });

  it('allows templated names so loops do not collide', async () => {
    const store = new InMemoryStore();

    async function fanOut(ctx: WorkflowCtx, input: { pkgs: string[] }): Promise<number> {
      let count = 0;
      for (const pkg of input.pkgs) {
        await ctx.step(`verify-${pkg}`, () => {
          count += 1;
        });
      }
      return count;
    }

    const result = await runWorkflow(fanOut, { pkgs: ['core', 'ui', 'cli'] }, { store });

    expect(result.status).toBe('completed');
    expect(result.output).toBe(3);
    const steps = await store.listSteps(result.runId);
    expect(steps.map((s) => s.name)).toEqual(['verify-core', 'verify-ui', 'verify-cli']);
  });
});
