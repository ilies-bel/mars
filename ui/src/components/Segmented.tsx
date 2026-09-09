import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A segmented control — one track, N mutually-exclusive or multi-select
 * options, exactly one visual affordance.
 *
 * The app previously expressed every one of these as a loose run of individual
 * bordered buttons (`FLAT  TIMELINE  REFRESH`, `INFO [WARN] [ERROR]`), some
 * with dashed borders for the inactive state. A row of five separately-bordered
 * boxes reads as five unrelated controls, so nothing communicates "these are
 * the options for one setting, and this is the one that is on".
 *
 * Grouping them onto a single recessed track with one raised active thumb is
 * the standard fix, and it is what makes a filter bar read as a filter bar.
 */
export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** Accessible name when `label` is an icon or an abbreviation. */
  title?: string
  'data-testid'?: string
}

export interface SegmentedProps<T extends string> {
  options: readonly SegmentedOption<T>[]
  /** Values currently on. Single-select passes a one-element set. */
  selected: ReadonlySet<T>
  onToggle: (value: T) => void
  /** Accessible group name, e.g. "Severity". */
  label: string
  /** Renders the group name as a visible leading label. */
  showLabel?: boolean
  className?: string
  'data-testid'?: string
}

export const Segmented = <T extends string>({
  options,
  selected,
  onToggle,
  label,
  showLabel = false,
  className,
  'data-testid': testId,
}: SegmentedProps<T>) => (
  <div className={cn('flex shrink-0 items-center gap-1.5', className)}>
    {showLabel && (
      <span className="text-micro font-medium text-muted-foreground">{label}</span>
    )}
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className="inline-flex items-center gap-0.5 rounded-md border border-border/70 bg-background p-0.5"
    >
      {options.map((opt) => {
        const on = selected.has(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={on}
            title={opt.title}
            data-testid={opt['data-testid']}
            onClick={() => onToggle(opt.value)}
            className={cn(
              'inline-flex h-6 items-center rounded px-2 text-micro font-medium',
              'transition-[background-color,color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              on
                ? 'bg-surface text-foreground shadow-[var(--shadow-e1)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  </div>
)
