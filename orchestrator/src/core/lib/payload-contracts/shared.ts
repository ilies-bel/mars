/**
 * Shared payload shapes used by more than one kind-family module.
 */

/**
 * `raiseActionQueueItem` appends each repeat sighting's `occurrence` object to
 * `payload.occurrences`. Raisers never write this key themselves, so it is
 * optional on every contract that can be deduped.
 */
export interface OccurrenceTrail {
  occurrences?: readonly Record<string, unknown>[]
}
