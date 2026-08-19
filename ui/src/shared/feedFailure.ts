/**
 * One place that turns a failed data feed into words an operator can act on.
 *
 * `ApiError.kind` already distinguishes four genuinely different situations,
 * each with its own remedy (see the doc comment on `ApiErrorKind`). Every
 * surface that rendered one generic sentence for all four was throwing that
 * away — and the generic sentence advised restarting the daemon, which is
 * actively wrong for the two most common cases: a daemon that is stopped (it
 * needs starting, not restarting) and a schema mismatch (restarting changes
 * nothing).
 *
 * Keep the remedy a literal command. "Try restarting" makes the operator guess
 * which of `mars daemon start`, `restart`, or `mars ui` was meant.
 */

import type { ApiErrorKind } from './api'

/**
 * Read the classified kind off an error without an `instanceof` check.
 *
 * `ApiError` is a class, but the only thing this module needs from it is the
 * `kind` string. Duck-typing keeps the check correct when the error crosses a
 * module boundary that gives it a different class identity — separate bundle
 * chunks, HMR reloads, or a test that mocks `@/shared/api`.
 */
const kindOf = (error: Error): ApiErrorKind | null => {
  const kind = (error as { kind?: unknown }).kind
  return kind === 'unreachable' ||
    kind === 'stale-daemon' ||
    kind === 'stale-daemon-code'
    ? kind
    : null
}

export interface FeedFailure {
  /** What went wrong, in one clause. No trailing punctuation. */
  message: string
  /** The exact command that fixes it, or null when there isn't one. */
  remedy: string | null
}

export const describeFeedFailure = (
  error: Error,
  /** What failed to load, e.g. "action queue". Used in the fallback message. */
  label: string,
): FeedFailure => {
  switch (kindOf(error)) {
    case 'unreachable':
      return {
        message: "Can't reach the Mars daemon",
        remedy: 'mars daemon start',
      }
    case 'stale-daemon':
      return {
        message: 'The daemon stopped answering — its port file is stale',
        remedy: 'mars daemon restart',
      }
    case 'stale-daemon-code': {
      const { sourceSha, currentSha } = error as {
        sourceSha?: string
        currentSha?: string
      }
      const shas =
        sourceSha && currentSha
          ? ` (running ${sourceSha}, HEAD is ${currentSha})`
          : ''
      return {
        message: `The daemon is running older code than this UI expects${shas}`,
        remedy: 'mars daemon restart',
      }
    }
    default:
      return { message: `Couldn't load ${label}`, remedy: null }
  }
}
