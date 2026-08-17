/**
 * Declaration merging into cordis's `Context`.
 *
 * Cordis's `Context` is NOT generic — the old `Container<M, E>` type parameters
 * have no counterpart. A consumer types its own service slots and events by
 * merging into `interface Context` / `interface Events` instead, which is
 * strictly better than the closed `EventMap` it replaces: a downstream plugin
 * can declare its own event without the engine knowing about it.
 *
 * This file declares only what the ENGINE owns. It stays domain-agnostic (the
 * `workflow-package-is-domain-agnostic` arch rule forbids reaching into
 * `orchestrator/` even for a type), so the sealed slots are `unknown` and the
 * host narrows them. The engine's own event map is declared next to its emitter
 * in `../workflow.ts`.
 */

import type {} from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The task-state store — a SEALED service (ADR-0052). Installed by the
     * engine as a context accessor, which is why it cannot be `provide`d,
     * re-declared, isolated or assigned. See `./sealed.ts`.
     *
     * `unknown` because the engine is domain-agnostic; the host narrows it.
     */
    store: unknown;
    /**
     * The trace-event store — sealed on the same terms as {@link store}.
     */
    traceStore: unknown;
  }
}
