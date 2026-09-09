import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The shared page header.
 *
 * Every page previously rolled its own strip, and they all reached for the
 * same `font-mono text-title` (14px) — the exact size used by card titles and
 * only 1px above body copy. A page title that is the same size as the content
 * under it gives the eye nowhere to land, which is why every screen read flat
 * regardless of how well the content itself was laid out.
 *
 * This sets the top of the type hierarchy: `text-heading` (18px) in Inter with
 * negative tracking, an optional count pill, an optional one-line subtitle,
 * and a right-aligned actions slot. Sticky, with a hairline that only appears
 * once the content scrolls beneath it.
 */
export interface PageHeaderProps {
  title: string
  /** Rendered as a pill beside the title. Omit or pass null for no pill. */
  count?: number | null
  /** Accessible description of the count, e.g. "12 items need attention". */
  countLabel?: string
  /** One-line context under the title. */
  subtitle?: string
  /** Right-aligned controls — buttons, links, filters. */
  actions?: ReactNode
  /** Secondary row under the header proper (tabs, search, filters). */
  toolbar?: ReactNode
  className?: string
}

export const PageHeader = ({
  title,
  count = null,
  countLabel,
  subtitle,
  actions,
  toolbar,
  className,
}: PageHeaderProps) => (
  <div className={cn('shrink-0 border-b border-border bg-surface', className)}>
    <div className="flex items-center gap-3 px-5 pb-3 pt-3.5">
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
        <div className={cn('flex shrink-0 items-center gap-1.5', !subtitle && 'ml-auto')}>
          {actions}
        </div>
      )}
    </div>
    {toolbar && <div className="flex items-center gap-2 px-5 pb-3">{toolbar}</div>}
  </div>
)

/**
 * A section heading inside a page body. One step below PageHeader, one step
 * above card titles — the missing middle rung that forced pages to signal
 * "this is a new section" with an all-caps 10px mono label.
 */
export const SectionHeading = ({
  children,
  count,
  actions,
  className,
}: {
  children: ReactNode
  count?: number | null
  actions?: ReactNode
  className?: string
}) => (
  <div className={cn('flex items-center gap-2 pb-2', className)}>
    <h2 className="text-section font-semibold text-foreground">{children}</h2>
    {count !== null && count !== undefined && (
      <span className="text-label tabular-nums text-muted-foreground">{count}</span>
    )}
    {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
  </div>
)
