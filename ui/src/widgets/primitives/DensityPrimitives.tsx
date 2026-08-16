import type { ReactNode } from 'react'

/**
 * Density-language primitives shared by every redesigned page.
 *
 * PageHeader — compact mono page-header row (mockup shell-progress.html)
 * SectionLabel — small 10px uppercase mono column / rail heading label
 *
 * Both components consume only theme tokens; no raw palette classes are used.
 */

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-3.5 border-b border-border bg-surface px-6 py-3">
      <span className="font-mono text-[15px] font-semibold">{title}</span>
      {subtitle && (
        <span className="font-mono text-[10px] text-muted-foreground">{subtitle}</span>
      )}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  )
}

export function SectionLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
      {children}
    </span>
  )
}
