import { describe, it, expect } from 'vitest';
import { runWorkflow, InMemoryStore } from '../../src/index.js';
import type { WorkflowCtx } from '../../src/index.js';

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
      return ctx.step('read', () => [ctx.get('store'), ctx.get('logger'), ctx.container.get('store')]);
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

  it('a plugin loaded via ctx.container.plugin applies once its inject dependency is present, mid-run', async () => {
    const store = new InMemoryStore();

    async function pipeline(ctx: WorkflowCtx): Promise<unknown> {
      const seen: unknown[] = [];
      ctx.container.plugin<undefined>({
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
      // Plugin application is scheduled as a microtask off the 'provide'
      // event; give it a turn before checking.
      await Promise.resolve();
      await Promise.resolve();

      return ctx.step('after', () => seen);
    }

    const result = await runWorkflow(pipeline, undefined, { store });

    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.output).toEqual([{ connected: true }]);
    }
  });

  it('registrations made during the run are torn down (LIFO) once a completed run ends', async () => {
    const store = new InMemoryStore();
    const order: string[] = [];
    let capturedContainer: WorkflowCtx['container'] | undefined;

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      capturedContainer = ctx.container;
      ctx.provide('a', 'v1');
      ctx.container.events.on('probe' as never, (() => order.push('listener')) as never);
      ctx.provide('b', 'v2');
      await ctx.step('work', () => 'done');
    }

    const result = await runWorkflow(pipeline, undefined, { store });

    expect(result.status).toBe('completed');
    expect(capturedContainer?.disposed).toBe(true);
    expect(capturedContainer?.has('a')).toBe(false);
    expect(capturedContainer?.has('b')).toBe(false);
  });

  it('a failed run still disposes the container and runs registered teardown', async () => {
    const store = new InMemoryStore();
    const teardown = { plugin: false };
    let capturedContainer: WorkflowCtx['container'] | undefined;

    async function pipeline(ctx: WorkflowCtx): Promise<void> {
      capturedContainer = ctx.container;
      ctx.container.plugin<undefined>({
        name: 'has-teardown',
        apply() {
          return () => {
            teardown.plugin = true;
          };
        },
      });
      // Give the (no-inject) plugin's async apply() a turn to resolve and
      // register its teardown disposer before the step throws.
      await Promise.resolve();
      await Promise.resolve();
      await ctx.step('boom', () => {
        throw new Error('nope');
      });
    }

    const result = await runWorkflow(pipeline, undefined, { store });

    expect(result.status).toBe('failed');
    expect(capturedContainer?.disposed).toBe(true);
    expect(teardown.plugin).toBe(true);
  });
});
