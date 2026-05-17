/**
 * Tail-truncate a failure output string, keeping the last `max` characters.
 *
 * Failure signals (stack traces, exit-code lines, assertion messages) land at
 * the TAIL of captured output. Head-truncation silently discards them.
 * This helper always keeps the tail so the most diagnostic content survives.
 *
 * When truncation occurs, a brief marker is prepended so readers know the head
 * was dropped.
 */
export const truncateFailure = (s: string, max: number = 2000): string => {
  if (s.length <= max) return s
  return `[…truncated — showing last ${max} chars]\n${s.slice(-max)}`
}
