/**
 * EmptyState — the single "there is nothing here" render seam.
 *
 * Before this existed the app had three unrelated empty states: Needs You
 * centred a headline over an explanatory line and an escape hatch, Scores
 * put a two-paragraph essay in a bordered box, and Events emitted one bare
 * line of monospace muted text. A reader who learned what "nothing here"
 * looks like on one page learned nothing that transferred to the next.
 *
 * The shape is Needs You's, because it is the one that answers the two
 * questions an empty region actually raises:
 *
 *   1. `title`  — is this empty, or is it broken? (a headline, not a whisper)
 *   2. children — why is it empty, and is that expected?
 *   3. `action` — what do I do about it? (optional; omit when nothing applies)
 *
 * Deliberately NOT here: an icon slot. A grey glyph above every empty region
 * is decoration that reads as chrome after the second one.
 *
 * Sibling of ErrorState, and it shares that component's variant vocabulary:
 *
 *   `pane`   — centred, generous vertical room; for a whole page or panel.
 *   `inline` — compact and left-aligned; for a sub-section inside a page
 *              that still has other content around it.
 *
 * Usage:
 *   <EmptyState title="No scored runs yet">
 *     This page lists runs a scorer has graded, worst first.
 *   </EmptyState>
 */

import type { ReactNode } from 'react'

export interface EmptyStateProps {
  /** Headline. A statement of fact, sentence case, no trailing period. */
  title: string
  /** Why it is empty / what would fill it. Plain text or inline elements. */
  children?: ReactNode
  /** Optional escape hatch — a button or link. Omit when there is no move. */
  action?: ReactNode
  /** `pane` (default) for a whole region; `inline` for a sub-section. */
  variant?: 'pane' | 'inline'
  /** Forwarded so existing per-page assertions keep their handle. */
  'data-testid'?: string
}

export const EmptyState = ({
  title,
  children,
  action,
  variant = 'pane',
  'data-testid': testId = 'empty-state',
}: EmptyStateProps) => {
  if (variant === 'inline') {
    return (
      <div data-testid={testId} className="flex flex-col items-start gap-1.5 py-4">
        <p className="text-label font-medium text-foreground">{title}</p>
        {children != null && (
          <p className="max-w-[60ch] text-label text-muted-foreground">{children}</p>
        )}
        {action}
      </div>
    )
  }

  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center justify-center gap-2 px-6 py-24 text-center"
    >
      <p className="text-title font-medium text-foreground">{title}</p>
      {children != null && (
        // 60ch is the readable measure. Scores' empty state is a genuine
        // paragraph of explanation, so the body has to hold prose, not just
        // a caption.
        <p className="max-w-[60ch] text-label leading-relaxed text-muted-foreground">
          {children}
        </p>
      )}
      {action != null && <div className="mt-2">{action}</div>}
    </div>
  )
}
