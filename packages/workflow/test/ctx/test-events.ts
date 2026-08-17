/**
 * Event map for the container tests.
 *
 * Cordis's `Context` is not generic — `ctx.on(name, …)` is keyed on
 * `keyof Events`, and a consumer adds its own events by merging into that
 * interface. This file is the test suite doing exactly what a downstream plugin
 * would do, and is the executable demonstration that the mechanism replaces the
 * old `Container<M, E>` type parameters.
 */

import type {} from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Fire-and-forget observer event. */
    ping(n: number): void;
    /** Serial/bail routing decision — note the `false | null` returns. */
    classify(input: string): string | false | null | undefined;
    /** Waterfall middleware; the trailing argument is the innermost `next`. */
    compose(prompt: string, next: () => string): string;
    /** No-payload probe used by the run-container teardown tests. */
    probe(): void;
  }
}

export {};
