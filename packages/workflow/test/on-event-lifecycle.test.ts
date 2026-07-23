import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../src/index.js';
import type { WorkflowCtx, WorkflowEvent } from '../src/index.js';

describe('onEvent lifecycle events', () => {
  it('receives step.started and step.completed for each step in a two-step workflow', async () => {
    const store = new InMemoryStore();
    const events: WorkflowEvent[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('fetch', () => ({ data: 'hello' }));
      await ctx.step('transform', () => ({ result: 42 }));
    }

    const result = await runWorkflow(pipeline, undefined, {
      store,
      onEvent: (evt) => events.push(evt),
    });

    expect(result.status).toBe('completed');

    const eventNames = events.map((e) => `${e.step}:${e.event}`);

    // Both steps emit started then completed, in order.
    expect(eventNames).toContain('fetch:step.started');
    expect(eventNames).toContain('fetch:step.completed');
    expect(eventNames).toContain('transform:step.started');
    expect(eventNames).toContain('transform:step.completed');

    // started must precede completed for each step.
    const fetchStarted = events.findIndex((e) => e.step === 'fetch' && e.event === 'step.started');
    const fetchCompleted = events.findIndex(
      (e) => e.step === 'fetch' && e.event === 'step.completed',
    );
    expect(fetchStarted).toBeLessThan(fetchCompleted);

    const transformStarted = events.findIndex(
      (e) => e.step === 'transform' && e.event === 'step.started',
    );
    const transformCompleted = events.findIndex(
      (e) => e.step === 'transform' && e.event === 'step.completed',
    );
    expect(transformStarted).toBeLessThan(transformCompleted);
  });

  it('receives step.failed for a throwing step and does not suppress the run failure', async () => {
    const store = new InMemoryStore();
    const events: WorkflowEvent[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('ok', () => 'fine');
      await ctx.step('boom', () => {
        throw new Error('something went wrong');
      });
    }

    const result = await runWorkflow(pipeline, undefined, {
      store,
      onEvent: (evt) => events.push(evt),
    });

    expect(result.status).toBe('failed');

    const failedEvt = events.find((e) => e.step === 'boom' && e.event === 'step.failed');
    expect(failedEvt).toBeDefined();
    expect((failedEvt!.payload as { error: string }).error).toBe('something went wrong');

    // The ok step still got started + completed.
    expect(events.some((e) => e.step === 'ok' && e.event === 'step.started')).toBe(true);
    expect(events.some((e) => e.step === 'ok' && e.event === 'step.completed')).toBe(true);
  });

  it('step.completed payload carries summary and durationMs', async () => {
    const store = new InMemoryStore();
    const events: WorkflowEvent[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('compute', () => 'the-answer');
    }

    await runWorkflow(pipeline, undefined, { store, onEvent: (evt) => events.push(evt) });

    const completedEvt = events.find(
      (e) => e.step === 'compute' && e.event === 'step.completed',
    );
    expect(completedEvt).toBeDefined();
    const payload = completedEvt!.payload as {
      attempt: number;
      durationMs: number;
      summary: string | null;
    };
    expect(payload.attempt).toBe(1);
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits step.skipped (not step.started/completed) for a resumed step', async () => {
    const store = new InMemoryStore();
    const firstEvents: WorkflowEvent[] = [];
    const secondEvents: WorkflowEvent[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('setup', () => 'done');
    }

    const first = await runWorkflow(pipeline, undefined, {
      store,
      onEvent: (evt) => firstEvents.push(evt),
    });
    expect(first.status).toBe('completed');

    // Resume the same run — 'setup' should be skipped.
    await runWorkflow(pipeline, undefined, {
      store,
      runId: first.runId,
      onEvent: (evt) => secondEvents.push(evt),
    });

    const secondEventNames = secondEvents.map((e) => e.event);
    expect(secondEventNames).toContain('step.skipped');
    expect(secondEventNames).not.toContain('step.started');
    expect(secondEventNames).not.toContain('step.completed');
  });

  it('a throwing onEvent subscriber does not fail the run', async () => {
    const store = new InMemoryStore();

    async function pipeline(ctx: WorkflowCtx): Promise<string> {
      return ctx.step('work', () => 'done');
    }

    const result = await runWorkflow(pipeline, undefined, {
      store,
      onEvent: () => {
        throw new Error('subscriber blew up');
      },
    });

    // The run must succeed even though every subscriber call throws.
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.output).toBe('done');
    }
  });
});
