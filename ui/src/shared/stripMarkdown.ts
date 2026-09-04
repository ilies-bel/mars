/**
 * Strip common markdown syntax from a text string, leaving readable plain text.
 *
 * Used on surfaces that display operator-authored or agent-authored prose
 * (proposal bodies, etc.) without a full markdown renderer.  The goal is to
 * prevent literal `##` and backtick sequences from appearing on screen.
 *
 * Handles the patterns observed in practice:
 *   - Heading markers: `## Heading` → `Heading`
 *   - Inline code:     `` `foo` ``   → `foo`
 *   - Fenced blocks:   ``` … ```     → block body only
 *   - Bold:            `**foo**`     → `foo`
 *   - Italic asterisk: `*foo*`       → `foo`
 *
 * Note: underscore-based emphasis (`_foo_`) is intentionally NOT stripped —
 * underscores appear inside identifiers (e.g. `cost_per_arc_p90`) and
 * stripping them would garble technical terms. Agents rarely use `_..._`
 * emphasis anyway; the observable issue is heading markers and backticks.
 *
 * This is intentionally NOT a complete CommonMark parser; it covers the
 * constructs that agents routinely write in short proposal fields.
 */
export function stripMarkdown(text: string): string {
  return text
    // Fenced code blocks — keep the body, drop the ``` delimiters
    .replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm, '$1')
    // Heading markers (## Heading → Heading)
    .replace(/^#{1,6}[ \t]+/gm, '')
    // Inline code — double and single backticks (`foo` → foo)
    .replace(/``(.+?)``/gs, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    // Bold+italic asterisks: ***text***
    .replace(/\*{3}(.+?)\*{3}/gs, '$1')
    // Bold asterisks: **text**
    .replace(/\*{2}(.+?)\*{2}/gs, '$1')
    // Italic asterisks: *text* (only when surrounded by non-word chars or
    // line boundaries so `*` inside URLs is not stripped)
    .replace(/(^|[\s(])\*(\S[^*]*?\S|\S)\*($|[\s,.)!?])/gm, '$1$2$3')
}
