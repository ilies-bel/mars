import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Density-language primitives shared by every page.
 *
 * These are the top two rungs of the type hierarchy. Before they carried real
 * sizes, every page title rendered at `text-title` (14px) — the same size as
 * the card titles beneath it and one pixel above body copy. A page whose title
 * is the size of its content gives the eye nowhere to land, which is why every
 * screen read flat no matter how well the content itself was arranged.
 *
 *   PageHeader     18px semibold  — one per page, the top of the hierarchy
 *   SectionHeading 15px semibold  — a real heading inside a page body
 *   SectionLabel   11px caps      — a rail/column label, NOT a heading
 *
 * SectionLabel exists for genuinely small rail labels. Reaching for it to head
 * a page section (which pages used to do, for want of anything between 14px
 * and 10px caps) is what produced the wall of tiny uppercase mono.
 *
 * All three consume theme tokens only; no raw palette classes.
 */

export function PageHeader({
  title,
  subtitle,
  count = null,
  countLabel,
  actions,
  toolbar,
  className,
}: {
  title: string
  subtitle?: string
  /** Rendered as a pill beside the title. Null or 0 renders nothing. */
  count?: number | null
  /** Accessible description of the count, e.g. "12 items need attention". */
  countLabel?: string
  /** Right-aligned controls — buttons, links, filters. */
  actions?: ReactNode
  /** Secondary row under the header proper (tabs, search, filters). */
  toolbar?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('shrink-0 border-b border-border bg-surface', className)}>
      <div className="flex items-center gap-3 px-6 pb-3 pt-3.5">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="truncate text-heading font-semibold text-foreground">{title}</h1>
          {count !== null && count > 0 && (
            <span
              aria-label={countLabel ?? `${count} items`}
              className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-foreground/8 px-1.5 text-micro font-semibold leading-none tabular-nums text-muted-foreground"
            >
              {count}
            </span>
          )}
        </div>
        {subtitle && (
          <p className="min-w-0 flex-1 truncate text-label text-muted-foreground">{subtitle}</p>
        )}
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {actions}
          </div>
        )}
      </div>
      {toolbar && <div className="flex items-center gap-2 px-6 pb-3">{toolbar}</div>}
    </div>
  )
}

/**
 * A heading for a section inside a page body — the rung between PageHeader and
 * a card title that the app previously had no token for.
 */
export function SectionHeading({
  children,
  count,
  actions,
  className,
}: {
  children: ReactNode
  count?: number | null
  actions?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex items-center gap-2 pb-2.5', className)}>
      <h2 className="text-section font-semibold tracking-tight text-foreground">{children}</h2>
      {count !== null && count !== undefined && (
        <span className="text-label tabular-nums text-muted-foreground">{count}</span>
      )}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  )
}

/** A small uppercase rail / column label. Not a section heading — see above. */
export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="text-micro font-semibold uppercase tracking-[0.07em] text-muted-foreground">
      {children}
    </span>
  )
}
