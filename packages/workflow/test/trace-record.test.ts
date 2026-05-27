import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../src/index.js';
import type { WorkflowCtx } from '../src/index.js';

describe('per-step record for the trace view', () => {
  it('exposes name/status/sha/timestamps/retry/transcriptKey/summary', async () => {
    const store = new InMemoryStore();

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step(
        'code',
        (handle) => {
          // The body annotates its own record for the trace view.
          handle.setSha('cafef00d');
          handle.setTranscriptKey('transcript/code-001');
          handle.setSummary('wrote 12 files');
          return { files: 12 };
        },
      );
    }

    const result = await runWorkflow(pipeline, undefined, { store });
    expect(result.status).toBe('completed');

    const [code] = await store.listSteps(result.runId);
    expect(code.name).toBe('code');
    expect(code.status).toBe('completed');
    expect(code.sha).toBe('cafef00d');
    expect(code.transcriptKey).toBe('transcript/code-001');
    expect(code.summary).toBe('wrote 12 files');
    expect(code.attempt).toBe(1);
    expect(typeof code.startedAt).toBe('number');
    expect(typeof code.finishedAt).toBe('number');
    expect(code.finishedAt).toBeGreaterThanOrEqual(code.startedAt);
    // Full output is referenced by key, not inlined into `summary`.
    expect(code.summary?.length).toBeLessThan(200);
  });

  it('accepts sha and transcriptKey via the step options too', async () => {
    const store = new InMemoryStore();

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('setup', () => 'wt', { sha: 'base-sha', transcriptKey: 'k/setup' });
    }

    const result = await runWorkflow(pipeline, undefined, { store });
    const [setup] = await store.listSteps(result.runId);
    expect(setup.sha).toBe('base-sha');
    expect(setup.transcriptKey).toBe('k/setup');
  });
});
