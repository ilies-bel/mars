/**
 * Sealed services — the container half of the Arc write-funnel invariant
 * (ADR-0052).
 *
 * The invariant: task-state writes funnel through the store service, and a
 * plugin must not be able to substitute the object the framework-owned shell
 * writes through. That is enforced in layers; this file is the layer that makes
 * the container itself refuse.
 *
 * A sealed service is registered as a cordis **accessor**, not as a service,
 * and that choice is load-bearing. Given `ctx.accessor('store', { get })` with
 * no `set` hook, every route a plugin could take is closed BY THE FRAMEWORK,
 * not by convention:
 *
 *   ctx.provide('store', fake)                  → throws: already declared as accessor
 *   ctx.accessor('store', { get })               → throws: already declared as accessor
 *   ctx.set('store', fake)                       → throws: cannot set without provide
 *   ctx.store = fake                             → TypeError (proxy set trap returns false)
 *   ctx.isolate('store', s).provide('store', …)  → throws: already declared as accessor
 *
 * That last one is why an accessor rather than a plain `provide` from the root
 * fiber. A `provide`-based seal only rejects duplicates *within one isolation
 * scope*: `ctx.isolate('store', Symbol()).provide('store', fake)` opens a fresh
 * scope in which the name is free again. Accessors live in the flat, shared
 * `reflect.props` map, so isolation cannot reach around them.
 *
 * RESIDUAL RISK, EXPLICITLY ACCEPTED. `ctx.extend({ store: fake })` shadows the
 * accessor on that child context, because own properties always shadow in a
 * prototype chain. This is harmless: the framework-owned primitive shells
 * resolve the store from the run-scoped `services` bag captured at composition
 * time, never from whatever `ctx` a plugin hands them, so a child-local shadow
 * cannot change what the shell writes through. `test/ctx/sealed.test.ts` pins
 * exactly that.
 */

import type { Context } from '@deepseek-ai/cordis';

/**
 * The service names the engine seals on every run container.
 *
 * They are sealed unconditionally — even when the host injected no value —
 * because the invariant is "a workflow can never install a task-state store",
 * not "a workflow can never replace one that happens to be there".
 */
export const SEALED_SERVICE_KEYS = ['store', 'traceStore'] as const;

/** One of {@link SEALED_SERVICE_KEYS}. */
export type SealedServiceKey = (typeof SEALED_SERVICE_KEYS)[number];

/** Whether `name` is a name the engine seals. */
export function isSealedName(name: string): name is SealedServiceKey {
  return (SEALED_SERVICE_KEYS as readonly string[]).includes(name);
}

/**
 * Install `value` under `name` as a read-only, non-replaceable context
 * property, for the lifetime of `ctx`'s fiber.
 *
 * Throws if `name` is already declared on this context tree (as a service, an
 * accessor or a mixin) — sealing is a one-shot, framework-owned act.
 */
export function sealService(ctx: Context, name: string, value: unknown): void {
  ctx.accessor(name, { get: () => value });
}

/**
 * Read a named implementation off `ctx`, whether it was `provide`d as a service
 * or installed as a sealed accessor.
 *
 * Cordis's own `ctx.get(name)` reads the service store only — it returns
 * `undefined` for an accessor, which is by design there but wrong for a Mars
 * `ctx.get('store')`. Reading `ctx[name]` directly is not a substitute either:
 * on a plugin fiber an undeclared name THROWS (`cannot get property "x" without
 * inject`), and for a name that shadows a built-in (`logger`, `events`,
 * `registry`, …) it returns cordis's own service rather than the seeded one.
 * So: service store first, accessor second, `undefined` otherwise.
 */
export function readService(ctx: Context, name: string): unknown {
  const fromStore: unknown = ctx.get(name);
  if (fromStore !== undefined) return fromStore;
  if (ctx.reflect.props[name]?.type !== 'accessor') return undefined;
  return Reflect.get(ctx, name) as unknown;
}
