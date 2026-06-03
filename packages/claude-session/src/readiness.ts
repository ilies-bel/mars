/**
 * The string emitted by Claude's interactive CLI when it is ready to receive
 * the first message. Pass `readinessMarker: READINESS_MARKER` to `start` to
 * make the call block until Claude has finished initialising.
 *
 * Claude Code v2.x renders a TUI whose input prompt uses the heavy
 * right-pointing angle quotation mark (U+276F) followed by a
 * non-breaking space (U+00A0).  This two-character sequence appears in the
 * PTY output stream as soon as the interactive session is ready for the
 * first user message.
 */
// U+276F followed by U+00A0 (non-breaking space)
export const READINESS_MARKER = '❯ ';
