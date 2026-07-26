/**
 * Derives a human-readable title from a raw task prompt string.
 *
 * - Takes the first non-empty line of the prompt.
 * - Strips any leading Markdown heading markers (e.g. `#`, `##`, `###`).
 * - Cuts at the first sentence boundary, then hard-caps the length.
 * - Falls back to the full trimmed prompt when the first line is blank.
 *
 * The sentence cut and the cap matter: most task prompts are a whole brief
 * written as ONE long line, so "first line" alone returns several hundred
 * characters and a board card grows to the height of the viewport.
 *
 * Used by board cards, topology node labels, and any surface that turns a
 * raw task prompt into a display title.
 */

/** Longest title a card renders before ellipsis. */
const MAX_TITLE_LENGTH = 100

/** Boundaries that would leave a stub shorter than this are skipped. */
const MIN_SENTENCE = 24

/**
 * Cut `text` at the first sentence boundary that leaves a usefully long title.
 * A boundary is `.`, `!`, or `?` followed by whitespace.
 *
 * Colon is deliberately NOT a boundary: in these prompts it is a prefix
 * separator ("Slice 1 of 5: …", "fix(merge): …"), so cutting there yields a
 * trailing-colon stub rather than a title. Requiring trailing whitespace also
 * keeps dotted paths like `design/ui.pen` intact.
 */
const firstSentence = (text: string): string => {
  for (const m of text.matchAll(/[.!?]\s/g)) {
    const end = (m.index ?? 0) + 1
    if (end >= MIN_SENTENCE) return text.slice(0, end)
  }
  return text
}

export const titleFromPrompt = (prompt: string): string => {
  const first = (prompt.split(/\r?\n/, 1)[0] ?? '').trim()
  const clean = first.replace(/^#+\s*/, '')
  const base = clean.length > 0 ? clean : prompt.trim()
  const sentence = firstSentence(base).trim()
  if (sentence.length <= MAX_TITLE_LENGTH) return sentence
  return `${sentence.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`
}

/**
 * Display title for a task. Prefers the server-provided `intent` — a short
 * summary written at enqueue time — and falls back to the prompt for legacy
 * rows that predate the field.
 *
 * `intent` is normalised through the same deriver rather than trusted as-is:
 * plenty of stored intents are themselves a 200-char slab of Markdown ("# Slice
 * 11: …\n\n## New file: …"), because callers may pass one explicitly and nothing
 * sanitises it on the way in. Treating it as a *candidate* title keeps every
 * card readable regardless of what is in the column.
 */
export const taskTitle = (task: {
  intent?: string | null
  prompt: string
}): string => {
  const intent = task.intent?.trim()
  return titleFromPrompt(intent && intent.length > 0 ? intent : task.prompt)
}
