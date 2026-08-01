/**
 * Recipe auto-run event emission.
 *
 * When the recipe dispatcher auto-applies a taught recipe to a fresh failure
 * occurrence, it calls {@link emitRecipeAutoRun} to publish a `recipe-autorun`
 * bus event. The conversation Notice subscriber narrates them immediately;
 * the UI hero-delta also keeps them in its historical activity view.
 */

import { publishWithRetry } from '../lib/outbox.js';
import type { DbClient } from '../lib/db.js';

/** Payload for a recipe auto-run event. */
export interface RecipeAutorunPayload {
  /** Id of the taught recipe that was applied. */
  recipeId: string;
  /** The failure kind / signature that triggered the recipe. */
  failureKind: string;
  /** The task the recipe was applied to. */
  targetTaskId: string;
  /** ISO-8601 timestamp of when the auto-run fired. */
  at: string;
}

/**
 * Emit a `recipe-autorun` bus event.
 *
 * Called from the recipe dispatcher after it successfully applies a taught
 * recipe to a failing task. The event is written atomically through the
 * outbox so it survives crashes and participates in subscriber ordering.
 */
export async function emitRecipeAutoRun(
  client: DbClient,
  payload: RecipeAutorunPayload,
): Promise<void> {
  await publishWithRetry(client, 'recipe-autorun', payload);
}
