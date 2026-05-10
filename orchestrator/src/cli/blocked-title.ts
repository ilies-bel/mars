const MAX_TITLE_LEN = 80

/**
 * Synthesize a one-line title from a task prompt for display in `mars next`.
 *
 * Skips leading blank lines and standalone markdown headings ("# Goal",
 * "## How to implement this slice", ...) so that prompts which open with a
 * heading still surface the first real content line — empirically that's
 * what humans recognize as the title.
 */
export function blockedTaskTitle(prompt: string | null | undefined): string {
  if (!prompt) return '(no prompt)'
  const lines = prompt.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (/^#{1,6}\s/.test(line)) continue
    return line.length > MAX_TITLE_LEN ? `${line.slice(0, MAX_TITLE_LEN - 3)}...` : line
  }
  // Prompt is only blank lines or headings — fall back to the first non-empty
  // line (likely a heading) so the user still sees *something*.
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    return line.length > MAX_TITLE_LEN ? `${line.slice(0, MAX_TITLE_LEN - 3)}...` : line
  }
  return '(no prompt)'
}
