import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../src/index.js';
import type { FiberStatusPayload, WorkflowCtx, WorkflowEvent } from '../src/index.js';

describe('fiber.status WorkflowEvent — beyond-parity §5.3', () => {
  it('reports the full lifecycle of a plugin explicitly disposed mid-run', async () => {
    const store = new InMemoryStore();
    const events: WorkflowEvent[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('provider', async () => {
        const fiber = ctx.container.plugin({ name: 'my-plugin', apply() {} });
        await fiber.await();
        // Dispose while the run (and this listener) is still live — the
        // reliable case: nothing races the listener's own teardown.
        await fiber.dispose();
      });
    }

    const result = await runWorkflow(pipeline, undefined, {
      store,
      onEvent: (evt) => events.push(evt),
    });
    expect(result.status).toBe('completed');

    const fiberEvents = events.filter((e) => e.event === 'fiber.status');
    const transitions = fiberEvents.map((e) => {
      const payload = e.payload as FiberStatusPayload;
      return `${payload.name}:${payload.from}->${payload.to}`;
    });

    expect(transitions).toEqual([
      'my-plugin:PENDING->LOADING',
      'my-plugin:LOADING->ACTIVE',
      'my-plugin:ACTIVE->UNLOADING',
      'my-plugin:UNLOADING->DISPOSED',
    ]);

    // fiber.status events are not attributed to a step (they are
    // container-level, not step-level).
    expect(fiberEvents.every((e) => e.step === null)).toBe(true);
  });

  it('reports at least PENDING/LOADING/ACTIVE for a plugin left to the run\'s own teardown', async () => {
    const store = new InMemoryStore();
    const events: WorkflowEvent[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      await ctx.step('provider', () =>
        ctx.container.plugin({ name: 'my-plugin', apply() {} }),
      );
    }

    const result = await runWorkflow(pipeline, undefined, {
      store,
      onEvent: (evt) => events.push(evt),
    });
    expect(result.status).toBe('completed');

    const transitions = events
      .filter((e) => e.event === 'fiber.status')
      .map((e) => {
        const payload = e.payload as FiberStatusPayload;
        return `${payload.from}->${payload.to}`;
      });

    // The tail (this run's own teardown disposing a fiber nothing disposed
    // earlier) is best-effort — see the doc comment on FiberStatusPayload —
    // but everything that happens while the run is still live is guaranteed.
    expect(transitions.slice(0, 2)).toEqual(['PENDING->LOADING', 'LOADING->ACTIVE']);
  });

  it('excludes the root fiber\'s own bookkeeping transitions', async () => {
    const store = new InMemoryStore();
    const events: WorkflowEvent[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<string> {
      return ctx.step('work', () => 'done');
    }

    await runWorkflow(pipeline, undefined, { store, onEvent: (evt) => events.push(evt) });

    // No plugin was ever registered on ctx.container, so no fiber.status
    // event should exist at all — the root fiber's own transitions are
    // filtered out, not just any plugin fiber's.
    expect(events.some((e) => e.event === 'fiber.status')).toBe(false);
  });

  it('a plugin that FAILS to load reports its transition to FAILED', async () => {
    const store = new InMemoryStore();
    const events: WorkflowEvent[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      const fiber = ctx.container.plugin({
        name: 'explodes',
        apply() {
          throw new Error('boom');
        },
      });
      await ctx.step('provider', async () => {
        await fiber.await().catch(() => undefined);
      });
    }

    await runWorkflow(pipeline, undefined, { store, onEvent: (evt) => events.push(evt) });

    const transitions = events
      .filter((e) => e.event === 'fiber.status')
      .map((e) => (e.payload as FiberStatusPayload).to);
    expect(transitions).toContain('FAILED');
  });
});
