/**
 * ScoreBar — one scorer verdict, rendered the same way wherever it appears.
 *
 * The Scores table and the Scores detail page used to disagree about whether a
 * score was worth showing at all. The table drew a tinted bar and the number;
 * the page you reached BY CLICKING THAT NUMBER never mentioned it again —
 * you arrived at a run graded 0.15 and the word "0.15" appeared nowhere on
 * the destination. Sharing one component is what keeps a score meaning the
 * same thing on both sides of a navigation.
 *
 * The tone is a judgement, not decoration: under 0.5 is a bad run, 0.5–0.8 is
 * unremarkable, 0.8 and up is good. The bar exists so a column of scores can
 * be scanned for the bad ones without reading every digit — 0.35 and 0.85 were
 * previously the same 13px black text.
 */

import { cn } from '@/lib/utils'

export interface ScoreBarProps {
  /** The scorer's verdict in [0,1], or null when the run was never scored. */
  score: number | null
  /** `sm` for a table cell, `lg` for a page header. */
  size?: 'sm' | 'lg'
  'data-testid'?: string
}

/** Under 0.5 bad, 0.5–0.8 unremarkable, 0.8+ good. */
const toneFor = (score: number): string =>
  score >= 0.8 ? 'bg-success' : score >= 0.5 ? 'bg-warn' : 'bg-error'

export const ScoreBar = ({ score, size = 'sm', 'data-testid': testId = 'score-bar' }: ScoreBarProps) => {
  if (score === null) {
    return (
      <span data-testid={testId} className="text-muted-foreground">
        —
      </span>
    )
  }
  const pct = Math.max(0, Math.min(1, score)) * 100
  return (
    <span
      data-testid={testId}
      className={cn('flex items-center', size === 'lg' ? 'gap-3' : 'gap-2')}
    >
      <span
        className={cn(
          'shrink-0 overflow-hidden rounded-full bg-foreground/8',
          size === 'lg' ? 'h-2 w-32' : 'h-1.5 w-24',
        )}
      >
        <span
          className={cn('block h-full rounded-full', toneFor(score))}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={cn(
          'tabular-nums text-foreground',
          size === 'lg' ? 'text-display font-semibold leading-none' : 'text-label',
        )}
      >
        {score.toFixed(2)}
      </span>
    </span>
  )
}
