/**
 * Per-invocation agent session keys. Split out of
 * `workflows/primitives/index.ts` (TARGET §2.1).
 */
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Session-key construction (exported for regression tests)
// ---------------------------------------------------------------------------

/**
 * Build a per-invocation session key for a Claude Code dispatch.
 *
 * Format: `<taskId>#<8-hex-random>` — the taskId prefix keeps logs attributable
 * while the random suffix guarantees uniqueness across parallel dispatches and
 * `mars continue` re-entries that would otherwise collide on the same session ID
 * (fix df826e9b, 2026-06-24).
 *
 * Both spawn paths (PTY and headless/stream) normalise the key to a valid UUID
 * via `toClaudeSessionId` before it reaches `claude --session-id`, so a
 * non-UUID key is acceptable here.
 */
export function buildSessionKey(taskId: string): string {
  return `${taskId}#${randomUUID().slice(0, 8)}`
}
