/**
 * The run container — one cordis `Context` per `runWorkflow` invocation.
 *
 * Composition order matters and is fixed here rather than at the call site:
 *
 *   1. a fresh root `Context` (installs `events` / `logger` / `reflect` /
 *      `registry`; its root fiber is ACTIVE from construction, so services
 *      registered on it are immediately visible to a strict `ctx.get`);
 *   2. a logger exporter bridging cordis's own error reporting — which is where
 *      a failed plugin load, a throwing disposer and a rejected effect all end
 *      up — into the host's error sink. This replaces the removed
 *      `ContainerOptions.onError`;
 *   3. the SEALED services (ADR-0052), before anything else can claim their
 *      names;
 *   4. one `provide` per own enumerable property of the `services` bag, so
 *      `ctx.get('x')` reaches `ctx.services.x` with no work from the caller.
 *
 * Teardown is {@link disposeRunContainer}. Cordis's root fiber cannot be
 * destroyed — `rootFiber.dispose()` is a restart — but that restart runs every
 * disposer registered since construction, in reverse order, which is exactly
 * the "reverse everything this run registered" contract the engine needs. The
 * built-in services survive it because `new Context()` deliberately detaches
 * their effects from the root fiber.
 */

import { Context } from '@deepseek-ai/cordis';
import { SEALED_SERVICE_KEYS } from './sealed.js';
import { sealService } from './sealed.js';

/** Where container-level failures go. `source` names the mechanism that failed. */
export type ContainerErrorHandler = (error: unknown, source: string) => void;

export interface RunContainerOptions {
  /**
   * The run's service bag. Every own enumerable property becomes a container
   * registration, except the sealed names, which become accessors.
   */
  services?: unknown;
  /**
   * Called when a plugin fails to load, a disposer throws, or an effect
   * rejects. Cordis reports all three through `ctx.logger.error`; this bridges
   * that to the host. The default swallows.
   */
  onError?: ContainerErrorHandler;
}

/** Thrown when a service key cannot be registered on a cordis context. */
export class ReservedServiceNameError extends Error {
  readonly key: string;

  constructor(key: string, cause: unknown) {
    super(
      `Cannot register service "${key}" on the run container: the name is reserved by ` +
        `the container itself (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Rename the service — cordis mixes its own API (get/set/provide/accessor/mixin/` +
        `effect/inject/plugin/on/once/emit/parallel/serial/bail/waterfall) onto every ` +
        `context, and the engine seals ${SEALED_SERVICE_KEYS.join(' and ')}.`,
    );
    this.name = 'ReservedServiceNameError';
    this.key = key;
  }
}

/** Build the container for one run. */
export function createRunContainer(options: RunContainerOptions = {}): Context {
  const onError = options.onError;
  const ctx = new Context();

  if (onError) {
    // Installed straight onto the exporter map rather than through
    // `ctx.logger.exporter()`, which registers it as an EFFECT of the root
    // fiber. An effect is torn down by the very teardown whose failures this
    // bridge exists to report, and loses the race: cordis routes a throwing
    // disposer to the logger several microtasks after the disposers start, by
    // which time an effect-registered exporter is already gone. Key `0` is
    // outside cordis's own id sequence, which starts at 1.
    ctx.logger.exporters.set(0, {
      export: (message) => {
        if (message.type !== 'error') return;
        onError(message.args[0] ?? message, `cordis:${message.name}`);
      },
    });
  }

  // Sealed first, unconditionally — including when the host injected nothing.
  // The invariant is "a workflow can never install a task-state store", not
  // "a workflow can never replace the one that happens to be there".
  const services = asRecord(options.services);
  for (const key of SEALED_SERVICE_KEYS) {
    sealService(ctx, key, services?.[key]);
  }

  if (services) {
    for (const [key, value] of Object.entries(services)) {
      if ((SEALED_SERVICE_KEYS as readonly string[]).includes(key)) continue;
      try {
        ctx.provide(key, value);
      } catch (error) {
        throw new ReservedServiceNameError(key, error);
      }
    }
  }

  return ctx;
}

/**
 * Reverse everything this run registered — services, accessors, listeners,
 * plugin fibers, effects — in reverse registration order.
 *
 * Never throws: teardown runs in `runWorkflow`'s `finally`, where a throw would
 * replace the run's own result.
 */
export async function disposeRunContainer(
  ctx: Context,
  onError?: ContainerErrorHandler,
): Promise<void> {
  try {
    await ctx.fiber.dispose();
  } catch (error) {
    onError?.(error, 'container.dispose');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as Record<string, unknown>;
}
