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

/**
 * The reading measure a list page holds its content to.
 *
 * PageBody already owns the page GUTTER — one number, applied once, so the
 * shell does not jump sideways on navigation. This is the other half: the cap
 * on how wide a column of cards may grow inside that gutter.
 *
 * It exists as a shared constant because the two pages that need it each
 * invented their own and then drifted. Measured at 1512px before this was
 * shared: Draft proposals put its h1 at x=248, its search field at 240 and its
 * cards at 344 — three different left edges on one page, because the card list
 * carried `mx-auto max-w-[1080px]` and centred itself inside the pane rather
 * than aligning to the gutter its header used. Needs You had exactly the same
 * defect and was fixed in isolation, which is how a fix stays local instead of
 * becoming a rule.
 *
 * Apply it to the header toolbar and to the body content; never add a gutter
 * alongside it — that belongs to PageBody or to the page's own scroll
 * container, which is why this constant deliberately carries no `px-*`.
 */
export const PAGE_MEASURE = 'max-w-[1080px]'

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
 * The scrolling body beneath a PageHeader — and the single owner of the page
 * gutter.
 *
 * PageHeader is a full-bleed band: it carries its own `px-6`, a bottom rule and
 * a surface, so it is meant to span the content column edge to edge. Pages that
 * *also* wrapped it in a padded `<main>` got both paddings, and the content
 * gutter measured 248px on triage, 264px on events and 272px on kpi/steward —
 * the shell visibly jumped sideways on every navigation.
 *
 * The rule this encodes: the page container adds no horizontal padding, the
 * header owns its own, and PageBody owns the body's. One gutter, one number.
 * It also makes the header stay put while the body scrolls, which is what a
 * header band is for.
 */
export function PageBody({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4', className)}>
      {children}
    </div>
  )
}

/** The outer frame every page shares: full height, no gutter of its own. */
export function PageShell({
  children,
  className,
  testId,
}: {
  children: ReactNode
  className?: string
  testId?: string
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className={cn('flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background', className)}
    >
      {children}
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
  verdict,
  actions,
  className,
}: {
  children: ReactNode
  count?: number | null
  /**
   * The answer the section computes, stated in the heading.
   *
   * A heading that names a noun and a total ("Gates 12") makes the reader do
   * the counting the page has already done — they must scan twelve rows to
   * learn that seven are red. The verdict slot is where that sentence goes
   * ("7 of 12 failing · oldest 2w ago"). Tone belongs to the caller, because
   * only the caller knows whether its answer is good news.
   */
  verdict?: ReactNode
  actions?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex items-baseline gap-2 pb-2.5', className)}>
      <h2 className="text-section font-semibold tracking-tight text-foreground">{children}</h2>
      {count !== null && count !== undefined && (
        <span className="text-label tabular-nums text-muted-foreground">{count}</span>
      )}
      {verdict && <span className="text-label">{verdict}</span>}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  )
}

/** A small uppercase rail / column label. Not a section heading — see above. */
export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="eyebrow text-muted-foreground">
      {children}
    </span>
  )
}
