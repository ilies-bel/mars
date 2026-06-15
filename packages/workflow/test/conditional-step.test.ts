import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../src/index.js';
import type { WorkflowCtx } from '../src/index.js';

interface ImplementInput {
  qa: 'full' | 'none';
}

async function implement(
  ctx: WorkflowCtx<unknown, ImplementInput>,
  input: ImplementInput,
): Promise<{ verified: boolean }> {
  await ctx.step('setup', () => '/tmp/wt');
  await ctx.step('code', () => ({ sha: 'deadbeef' }));
  let verified = false;
  if (input.qa !== 'none') {
    await ctx.step('verify', () => {
      verified = true;
    });
  }
  await ctx.step('merge', () => true);
  return { verified };
}

describe('conditional step (native if)', () => {
  it('records the verify step only when the branch is taken', async () => {
    const store = new InMemoryStore();
    const result = await runWorkflow(implement, { qa: 'full' }, { store });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ verified: true });
    const names = (await store.listSteps(result.runId)).map((s) => s.name);
    expect(names).toEqual(['setup', 'code', 'verify', 'merge']);
  });

  it('omits the verify step entirely when the branch is skipped', async () => {
    const store = new InMemoryStore();
    const result = await runWorkflow(implement, { qa: 'none' }, { store });

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ verified: false });
    const names = (await store.listSteps(result.runId)).map((s) => s.name);
    expect(names).toEqual(['setup', 'code', 'merge']);
    expect(names).not.toContain('verify');
  });
});
