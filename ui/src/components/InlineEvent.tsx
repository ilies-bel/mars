/**
 * InlineEvent — renders a narration event emitted while the operator is present.
 *
 * Intentionally lower-emphasis than a chat bubble: no background, smaller
 * text, muted colour, and `aria-live="off"` so it never interrupts a
 * screen-reader mid-sentence. The element is non-interactive (no focus,
 * no scroll-anchor) so it does not compete with the composer or Cards.
 */

interface InlineEventProps {
  /** The narration text to display inline (e.g. "Task abc123 landed"). */
  content: string
}

export function InlineEvent({ content }: InlineEventProps) {
  return (
    <p
      className="px-4 py-0.5 text-xs text-muted-foreground font-mono select-none"
      aria-live="off"
    >
      {content}
    </p>
  )
}
