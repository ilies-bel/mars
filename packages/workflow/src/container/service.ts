/**
 * MOVED — the keyed service registry now lives at `../ctx/registry.ts`.
 *
 * This file is a compatibility shim for the last consumer inside the native
 * container (`container.ts`'s plugin scheduler), which cordis's `Fiber`
 * replaces. It goes away with the rest of `src/container/`.
 */

export type {
  ServiceMap,
  ServiceRegistry,
  ServiceChangeEvents,
  ServiceChanges,
} from '../ctx/registry.js';
export { createServiceRegistry, ServiceNotFoundError } from '../ctx/registry.js';
