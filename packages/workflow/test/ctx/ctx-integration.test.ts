import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../../src/index.js';
import type { WorkflowCtx, WorkflowEvent } from '../../src/index.js';

interface Services {
  store: { name: string };
  logger: { level: string };
}

describe('WorkflowCtx.container — layered on ctx.services, not a replacement', () => {
  it('ctx.services keeps working exactly as before', async () => {
    const store = new InMemoryStore();
    const services: Services = { store: { name: 'arc' }, logger: { level: 'info' } };

    async function pipeline(ctx: WorkflowCtx<Services>): Promise<Services> {
      return ctx.step('read', () => ctx.services);
    }

    const result = await runWorkflow(pipeline, undefined, { store, services });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.output).toBe(services);
    }
  });

  it('ctx.get(key) reaches the same value as ctx.services[key] — the container is seeded from services', async () => {
    const store = new InMemoryStore();
    const services: Services = { store: { name: 'arc' }, logger: { level: 'info' } };

    async function pipeline(ctx: WorkflowCtx<Services>): Promise<unknown[]> {
      return ctx.step('read', () => [
        ctx.get('store'),
        ctx.get('logger'),
        // `store` is SEALED — a context accessor, not a service registration —
        // so it is read as a context property. Cordis's `container.get(name)`
        // reads the service store and skips accessors by design; `ctx.get` is
        // the Mars read path that resolves both.
        ctx.container.store,
      ]);
    }

    const result = await runWorkflow(pipeline, undefined, { store, services });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.output).toEqual([services.store, services.logger, services.store]);
    }
  });

  it('ctx.provide(key, value) registers into the same container ctx.get reads from', async () => {
    const store = new InMemoryStore();

    async function pipeline(ctx: WorkflowCtx): Promise<unknown> {
      ctx.provide('extra', { added: true });
      return ctx.step('read', () => ctx.get('extra'));
    }

    const result = await runWorkflow(pipeline, undefined, { store });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.output).toEqual({ added: true });
    }
  });

  it('ctx.provide cannot install a task-state store — the Arc funnel is sealed (ADR-0052)', async () => {
    const store = new InMemoryStore();
    const services: Services = { store: { name: 'arc' }, logger: { level: 'info' } };

    async function pipeline(ctx: WorkflowCtx<Services>): Promise<string> {
      ctx.provide('store', { name: 'rogue' });
      return 'unreachable';
    }

    const result = await runWorkflow(pipeline, undefined, { store, services });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.message).toMatch(/already declared as accessor/);
    }
  });

  it('a plugin loaded via ctx.container.plugin applies once its inject dependency is present, mid-run', async () => {
    const store = new InMemoryStore();

    async function pipeline(ctx: WorkflowCtx): Promise<unknown> {
      const seen: unknown[] = [];
      const fiber = ctx.container.plugin({
        name: 'needs-db',
        inject: ['db'],
        apply(pluginCtx) {
          seen.push(pluginCtx.get('db'));
        },
      });

      // Not yet satisfied.
      await ctx.step('before', () => 'noop');
      expect(seen).toEqual([]);

      ctx.provide('db', { connected: true });
      // The fiber is awaitable — no microtask-flush hack needed any more.
      await fiber.await();

      return ctx.step('after', () => seen);
    }

    const result = await runWorkflow(pipeline, undefined, { store });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.output).toEqual([{ connected: true }]);
    }
  });

  it('registrations made during the run are reversed once a completed run ends', async () => {
    const store = new InMemoryStore();
    let container: WorkflowCtx['container'] | undefined;

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      container = ctx.container;
      ctx.provide('a', 'v1');
      ctx.container.on('probe', () => {});
      ctx.provide('b', 'v2');
      await ctx.step('work', () => 'done');
    }

    const result = await runWorkflow(pipeline, undefined, { store });

    expect(result.status).toBe('completed');
    // Cordis's ROOT fiber cannot be destroyed — disposing it runs every
    // registration made since construction and leaves the (now empty) context
    // behind — so the observable teardown contract is "nothing survives",
    // not a `disposed` flag.
    expect(container?.get('a')).toBeUndefined();
    expect(container?.get('b')).toBeUndefined();
  });

  it('a failed run still tears the container down and runs registered teardown', async () => {
    const store = new InMemoryStore();
    const teardown = { plugin: false };
    let container: WorkflowCtx['container'] | undefined;

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      container = ctx.container;
      // Cordis IGNORES a disposer returned from apply(); teardown is an effect.
      await ctx.container.plugin({
        name: 'has-teardown',
        apply(pluginCtx) {
          pluginCtx.provide('from-plugin', true);
          pluginCtx.effect(() => () => {
            teardown.plugin = true;
          });
        },
      });
      await ctx.step('boom', () => {
        throw new Error('nope');
      });
    }

    const result = await runWorkflow(pipeline, undefined, { store });

    expect(result.status).toBe('failed');
    expect(teardown.plugin).toBe(true);
    expect(container?.get('from-plugin')).toBeUndefined();
  });

  it('republishes every progress event on the container bus, fault-isolated', async () => {
    const store = new InMemoryStore();
    const fromBus: string[] = [];
    const fromSink: string[] = [];

    async function pipeline(ctx: WorkflowCtx): Promise<string> {
      ctx.container.on('mars/workflow.event', (event: WorkflowEvent) => {
        fromBus.push(event.event);
      });
      // A throwing observer must never be able to fail the run it observes.
      ctx.container.on('mars/workflow.event', () => {
        throw new Error('observer exploded');
      });
      return ctx.step('work', () => 'done');
    }

    const result = await runWorkflow(pipeline, undefined, {
      store,
      onEvent: (event) => fromSink.push(event.event),
    });

    expect(result.status).toBe('completed');
    expect(fromBus).toEqual(['step.started', 'step.completed']);
    expect(fromSink).toEqual(['step.started', 'step.completed']);
  });
});
