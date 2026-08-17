# Cordis primer — the extension foundation

Mars's plugin/extension mechanism is not bespoke: `packages/workflow`'s
service container **is** [cordis 4](https://www.npmjs.com/package/@deepseek-ai/cordis)
(`Context`, `Fiber`, `ctx.plugin`, `ctx.effect`, the typed event bus), plus a
small, documented set of things cordis leaves to the host (`packages/workflow/src/ctx/`
— see `ARCHITECTURE.md` §5 and the module map's "Container" row). Every
`WorkflowCtx.container` a workflow run gets is a real cordis `Context`; every
plugin registered on it is a real cordis `Fiber`. This page is the ten-minute
version for someone who has never touched cordis before. For anything this
page doesn't answer, read the shipped `.d.ts` — it is the ground truth cordis
itself ships, and `mars/workflow` re-exports its primitives unchanged.

## The four ideas

1. **Context** — a `ctx` is a proxy over a service store. `ctx.plugin(fn)`
   or `ctx.plugin({ apply, inject, Config })` extends it into a child context
   for the plugin's own use, tracked by a **Fiber**.
2. **Fiber** — the lifecycle object behind a loaded plugin. It moves
   `PENDING → LOADING → ACTIVE` (or `→ FAILED`), and `→ UNLOADING → DISPOSED`
   on teardown, or back to `PENDING` if a required service disappears and
   re-appears. Mars republishes every transition as a `fiber.status`
   `WorkflowEvent` on the run's `ctx.emit`/`onEvent` stream — see
   `packages/workflow/src/workflow.ts`'s `FiberStatusPayload`.
3. **Services** — `ctx.provide(name, value)` registers one; `ctx.get(name)`
   or a plugin's `inject: [name]` reads one (injection additionally GATES
   loading: a plugin with `inject: ['foo']` stays `PENDING` until `foo`
   exists). `ctx.effect(() => teardown)` registers cleanup that runs in
   **reverse order** when the fiber unloads — the idiom to reach for instead
   of a manual `try/finally` or a module-level cleanup list.
4. **Events** — `ctx.on(name, listener)` / `ctx.emit` / `ctx.parallel` /
   `ctx.serial` / `ctx.bail` / `ctx.waterfall`, each dispatch-mode picking a
   different aggregation of listener results. Declare your own event's
   signature via TypeScript declaration merging (`declare module
   '@deepseek-ai/cordis' { interface Events { 'my/event'(x: Foo): void } }`)
   and every `ctx.on('my/event', ...)` call site is fully typed.

## Two things that are NOT stock cordis, and why

- **`store` / `traceStore` are sealed** (ADR-0052) — installed as read-only
  cordis *accessors*, not `provide`d services, so no plugin can substitute
  the Arc-backed task store a workflow writes through. Sealed names are
  **not injectable** (`inject: ['store']` never resolves — accessors don't
  participate in the service-store dependency gate); read them with
  `ctx.get('store')` (the `WorkflowCtx` helper, which checks both services
  and accessors) or a plain property read, `pluginCtx.store`.
- **`FiberState` is a TypeScript `const enum`**, erased from cordis's shipped
  JavaScript. Mars mirrors it as a frozen runtime object
  (`packages/workflow/src/ctx/fiber-state.ts`) — compare fiber states against
  that mirror (`FiberState.ACTIVE`, `fiberStateName(state)`), never against a
  value import of cordis's own `FiberState`.

## Where to go next

- **Author a workflow step as a cordis plugin** — the worked example lives in
  `orchestrator/src/init/templates/workflows/workflow-contract.md` §"Steps as
  cordis plugins".
- **See it proven, not just described** — `packages/workflow/test/ctx/*.test.ts`
  is a small, readable proof suite: plugin config validation
  (`config.test.ts`), fiber lifecycle (`lifecycle.test.ts`), effect ordering
  (`effect.test.ts`), the ADR-0052 seal (`sealed.test.ts`).
- **The full API** — cordis's own shipped `.d.ts` (`node_modules/@deepseek-ai/cordis/lib/types/`)
  is the ground truth; `mars/workflow` re-exports `Context`, `Service`,
  `Plugin`, `Inject`, `Fiber`, `FiberState`, `isBailed`, `symbols` unchanged
  (`orchestrator/src/workflows/authoring.ts`).
