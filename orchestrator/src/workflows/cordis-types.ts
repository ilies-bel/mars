/**
 * Orchestrator-owned declaration merging into cordis's `Context` / `Events`.
 *
 * `@mars/workflow` is deliberately domain-agnostic (the
 * `workflow-package-is-domain-agnostic` arch rule) — its own
 * `ctx/augmentations.ts` seals `store` / `traceStore` on the cordis `Context`
 * typed as `unknown`, because the engine cannot know the orchestrator's
 * concrete task-store / trace-store shapes. It CANNOT be re-narrowed here:
 * TypeScript requires every `declare module` augmentation of the same
 * interface member to agree on its type, so a second `store: DomainTaskStore`
 * declaration would conflict with the engine's `store: unknown` rather than
 * narrow it. Sealed slots stay `unknown` at the type level everywhere; read
 * them through `MarsCtx['services']['store']` (already `DomainTaskStore`) or
 * cast at the call site, exactly as before this file existed.
 *
 * What CAN be declared here — because nothing upstream claims these names —
 * are the Mars-owned, non-sealed entries `createRunContainer` registers onto
 * every run's container: every extra key of {@link MarsServices} beyond the
 * two sealed ones becomes a plain `ctx.provide(key, value)` (see
 * `packages/workflow/src/ctx/run-container.ts`), which means `ctx.get(key)`
 * and a plugin's `inject: [key]` already resolve them at RUNTIME today — they
 * were simply typed `unknown` because nothing told cordis their shape. This
 * file is that missing piece: importing `'mars/workflow'` (which imports this
 * module for its side effect via `./authoring.ts`) is enough for a plugin
 * author's `ctx.get('acquireVerifySlot')` or `inject: ['enqueueMergeJobAndAwait']`
 * to come back fully typed instead of `unknown`.
 *
 * Also declares the Mars-owned events published on the run container's bus
 * beyond the engine's own `mars/workflow.event` (declared in
 * `packages/workflow/src/workflow.ts`) — currently the growth step-suggestion
 * pipeline's event (`growth/step-suggestions.ts`).
 *
 * Side-effect-only import — no runtime code, purely `declare module`.
 */

import type {} from '@deepseek-ai/cordis';
import type { MarsServices } from './primitives';
import type { StepSuggestion } from '../growth/types';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Registered by the daemon (`MarsServices.onManualPark`) so a manual
     * step can park the task and await `mars step done` instead of the
     * legacy sentinel-throw path. Absent in scaffolded/test contexts that
     * don't wire the full daemon — always read with `ctx.get`, never
     * `inject`, unless the plugin is meant to be unusable outside a live run.
     */
    onManualPark: MarsServices['onManualPark'];
    /** PID-liveness hook for the coder/fixer subprocess (`MarsServices.onPid`). */
    onPid: MarsServices['onPid'];
    /** PID-liveness hook for verify subprocesses (`MarsServices.onVerifyChildPid`). */
    onVerifyChildPid: MarsServices['onVerifyChildPid'];
    /** Verify-concurrency semaphore acquire, paired with {@link releaseVerifySlot}. */
    acquireVerifySlot: MarsServices['acquireVerifySlot'];
    /** Verify-concurrency semaphore release, paired with {@link acquireVerifySlot}. */
    releaseVerifySlot: MarsServices['releaseVerifySlot'];
    /** Routes a merge request through the durable single-consumer merge worker. */
    enqueueMergeJobAndAwait: MarsServices['enqueueMergeJobAndAwait'];
    /** Spawns a long-lived preview process for the `reviewType: 'manual'` gate. */
    previewSpawn: MarsServices['previewSpawn'];
  }

  interface Events {
    /**
     * Fired by the growth step-suggestion pipeline (`growth/step-suggestions.ts`)
     * once per proposed suggestion, dispatched with `ctx.serial` so the single
     * registered persistence listener's return value (the proposal id) comes
     * straight back to the caller. See that module for the plugin that
     * listens for it.
     */
    'mars/growth.step-suggestion'(suggestion: StepSuggestion): Promise<string>;
  }
}
