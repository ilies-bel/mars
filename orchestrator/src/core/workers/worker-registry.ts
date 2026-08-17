/**
 * Worker registry — the open, runtime-registrable set of named Workers.
 * Replaces the closed `WorkerName` union and the static `WORKER_CONFIGS` /
 * `Workers` records that used to key off it (`core/workers/index.ts`).
 *
 * Deliberately has NO dependency on `./index` (which constructs the eight
 * built-in Workers via `buildWorker` and registers them here) — `index.ts`
 * depends on this module, not the other way around, so there is no import
 * cycle between "the registry" and "the built-ins that seed it".
 *
 * Built on `@mars/workflow`'s keyed service registry, same rationale as
 * `provider-registry.ts`: `register`/`get`/`require`/`list` over a plain
 * `Map`, reusing the container's primitive rather than a bespoke one.
 */

import { createServiceRegistry, type Disposer } from '@mars/workflow'
import type { Worker } from './index'

type WorkerMap = Record<string, Worker>

const registry = createServiceRegistry<WorkerMap>()

/** Register a Worker under its `config.name`. Built-ins self-register at import time (see `./index`). */
export const registerWorker = (worker: Worker): Disposer => registry.provide(worker.config.name, worker)

export const getWorker = (name: string): Worker | undefined => registry.get(name)

/** Like {@link getWorker}, but throws naming every registered Worker instead of returning `undefined`. */
export const requireWorker = (name: string): Worker => {
  if (!registry.has(name)) {
    const known = listWorkers()
      .map((w) => w.config.name)
      .sort()
      .join(', ')
    throw new Error(`Unknown worker '${name}' — known: ${known || '(none registered)'}`)
  }
  return registry.require(name)
}

export const listWorkers = (): readonly Worker[] => registry.keys().map((name) => registry.require(name))

/**
 * A live `Readonly<Record<string, V>>` view over the registry, built with a
 * `Proxy` so it supports every access pattern the old static
 * `WORKER_CONFIGS`/`Workers` records supported (`view.Coder`, `'Writer' in
 * view`, `Object.keys(view)`, `{ ...view }`) while staying backed by whatever
 * is currently registered.
 */
export const workerRegistryView = <V>(pick: (w: Worker) => V): Readonly<Record<string, V>> =>
  new Proxy({} as Record<string, V>, {
    get: (_t, prop) => {
      if (typeof prop !== 'string') return undefined
      const w = getWorker(prop)
      return w === undefined ? undefined : pick(w)
    },
    has: (_t, prop) => typeof prop === 'string' && getWorker(prop) !== undefined,
    ownKeys: () => listWorkers().map((w) => w.config.name),
    getOwnPropertyDescriptor: (_t, prop) => {
      if (typeof prop !== 'string') return undefined
      const w = getWorker(prop)
      if (w === undefined) return undefined
      return { enumerable: true, configurable: true, value: pick(w) }
    },
  })
