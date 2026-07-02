/**
 * Derives a human-readable title from a raw task prompt string.
 *
 * - Takes the first non-empty line of the prompt.
 * - Strips any leading Markdown heading markers (e.g. `#`, `##`, `###`).
 * - Falls back to the full trimmed prompt when the first line is blank.
 *
 * Used by board cards, topology node labels, and any surface that turns a
 * raw task prompt into a display title.
 */
export const titleFromPrompt = (prompt: string): string => {
  const first = (prompt.split(/\r?\n/, 1)[0] ?? '').trim()
  const clean = first.replace(/^#+\s*/, '')
  return clean.length > 0 ? clean : prompt.trim()
}
