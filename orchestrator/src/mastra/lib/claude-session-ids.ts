/**
 * Canonical parser for the `tasks.claude_session_ids` column.
 *
 * The column is an append-only JSON-array history of Claude session ids
 * (see queue.ts schema migration). Callers read it as `unknown` from the
 * libsql row and must tolerate `null`, non-string, malformed JSON, and
 * non-array payloads without throwing.
 *
 * This is the single importable home for the parse pattern that was
 * previously duplicated as a private `const` in `queue.ts` and
 * `lib/origin-timeline.ts`. Import it here instead of re-implementing.
 */
export const parseClaudeSessionIds = (raw: unknown): string[] => {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}
