import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

interface CollapsibleSectionProps {
  /** Uppercase section header shown in the summary trigger. */
  label: string
  /**
   * Accessible name for the trigger, when `label` alone does not identify it.
   *
   * A page that renders this component inside a list gets N triggers with the
   * same visible text — nine "Technical details" on #/steward, one or two per
   * verify gate. Visually each is anchored by the gate above it; to a screen
   * reader tabbing the page they are nine identical announcements with nothing
   * to tell them apart (WCAG 2.4.6 / 4.1.2).
   *
   * Lengthening `label` would fix the announcement and bloat the UI, so the
   * two names are allowed to differ: the eye keeps "Technical details", the
   * accessible name says which gate's.
   */
  srLabel?: string
  children: ReactNode
  /**
   * When true the section renders open on first paint.
   * Default: false (closed).
   */
  defaultOpen?: boolean
  /** Optional testid forwarded to the <details> root element. */
  'data-testid'?: string
  className?: string
}

/**
 * A consistently-styled collapsible section using native <details>/<summary>
 * semantics. Keyboard-accessible (Enter toggles natively), compatible with
 * renderToStaticMarkup (no JS required for initial render state).
 *
 * Shared primitive — use this wherever the codebase needs a collapsible
 * container with a labelled trigger, instead of inlining ad-hoc
 * <details>/<summary> pairs with diverging styles.
 */
export const CollapsibleSection = ({
  label,
  srLabel,
  children,
  defaultOpen = false,
  'data-testid': testId,
  className = '',
}: CollapsibleSectionProps) => {
  // Open state is tracked here rather than left to a CSS `group-open:`
  // variant. The variant compiled to nothing: the class landed on the svg in
  // every rendered disclosure in the app and no rule was ever emitted for it,
  // so every chevron in Mars pointed right whether its panel was open or shut
  // — and a unit test asserting the class STRING was present kept passing
  // throughout. Behaviour that matters is checked by reading the computed
  // transform, not by grepping the markup for a class name.
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details
      open={defaultOpen || undefined}
      data-testid={testId}
      className={className}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary
        aria-label={srLabel}
        className="eyebrow flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
      >
        {/* A real chevron, not a "▸" text glyph: the character's metrics and
            vertical centring vary per font, and it cannot take a stroke weight. */}
        <ChevronRight
          size={11}
          strokeWidth={2.5}
          className="shrink-0 transition-transform duration-150"
          style={open ? { transform: 'rotate(90deg)' } : undefined}
          aria-hidden="true"
        />
        {label}
      </summary>
      <div className="mt-1.5">
        {children}
      </div>
    </details>
  )
}
