/**
 * Derives a single-line display title from a task object.
 *
 * Fallback chain:
 *   1. `intent` when non-empty — heading markers (`#`) stripped defensively
 *      so pre-existing rows that stored a raw markdown heading (e.g.
 *      `# Main committer`) still render cleanly. The writer-side fix in
 *      `spawnMainCommitterRecovery` ensures NEW rows never store a heading-
 *      prefixed intent, but belt-and-braces here protects consumer databases
 *      that already contain polluted rows and cannot be retroactively cleaned.
 *   2. The prompt's first markdown heading with `#` markers and any trailing
 *      "Slice N of M …" scaffolding stripped.
 *   3. The prompt's first non-empty line, stripped the same way.
 *
 * In every tier the result has internal whitespace collapsed to single spaces
 * so a title can never spill a second line. The raw markdown heading marker
 * and multi-line fragments are therefore never returned.
 *
 * Callers that need a hard length cap should slice the return value themselves
 * (`taskDisplayTitle(t).slice(0, 60)`) — this function does not cap length.
 *
 * Used by: `mars list`, `mars show`, action-queue DAG node summaries, and
 * indirectly via the UI's own `taskTitle` (ui/src/shared/promptTitle.ts).
 */

/** Strips trailing "Slice N of M …" scaffolding from a line. */
const SLICE_RE = /\s+Slice\s+\d+\s+of\s+\d+(?:\s+for\s+PRD\b[^\n]*)?\s*$/i

/**
 * Strip leading `#` heading markers, trailing "Slice N of M" scaffolding,
 * and collapse internal whitespace to single spaces.
 */
function stripAndCollapse(raw: string): string {
  return raw
    .replace(/^#+\s*/, '')
    .replace(SLICE_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function taskDisplayTitle(task: { intent?: string | null; prompt: string }): string {
  // Tier 1 — explicit intent wins when non-empty.
  // `stripAndCollapse` is applied defensively so pre-existing rows that stored
  // a raw markdown heading (e.g. `# Main committer`) still render without the
  // `#` marker. The writer-side fix in `spawnMainCommitterRecovery` ensures new
  // rows never store a heading-prefixed intent, but consumer databases cannot be
  // retroactively cleaned — belt-and-braces here closes that gap permanently.
  const intent = task.intent?.trim()
  if (intent) return stripAndCollapse(intent)

  const lines = task.prompt.split('\n')

  // Tier 2 — first markdown heading.
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^#+\s/.test(trimmed)) {
      const stripped = stripAndCollapse(trimmed)
      if (stripped) return stripped
    }
  }

  // Tier 3 — first non-empty line (may itself be a bare `#` with no body;
  // `stripAndCollapse` will return '' in that edge case, so keep scanning).
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) {
      const stripped = stripAndCollapse(trimmed)
      if (stripped) return stripped
    }
  }

  return ''
}
