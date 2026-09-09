import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The app's metadata chip.
 *
 * Chips used to be hairline-bordered boxes with 10px mono text, which made
 * every one of them read as an input control rather than as a label — a row
 * with three chips looked like a row with three tiny buttons. A chip is not
 * interactive and should not borrow interactive chrome.
 *
 * The treatment here is a low-opacity tint of its own tone with no border, so
 * chips read as coloured text with a backing rather than as widgets. Tone
 * carries the meaning; weight carries the emphasis.
 */
export type ChipTone =
  | 'neutral'
  | 'error'
  | 'warn'
  | 'success'
  | 'accent'
  | 'info'
  | 'trace'

const TONE: Record<ChipTone, string> = {
  neutral: 'bg-foreground/6 text-muted-foreground',
  error: 'bg-error/10 text-error',
  warn: 'bg-warn/12 text-warn',
  success: 'bg-success/10 text-success',
  accent: 'bg-highlight/10 text-highlight',
  info: 'bg-primary/10 text-primary',
  trace: 'bg-trace-mars/10 text-trace-mars',
}

export interface ChipProps {
  tone?: ChipTone
  /** A small leading mark — a status dot, a lucide icon, or a glyph. */
  icon?: ReactNode
  children: ReactNode
  className?: string
  'data-testid'?: string
  title?: string
}

export const Chip = ({
  tone = 'neutral',
  icon,
  children,
  className,
  ...rest
}: ChipProps) => (
  <span
    className={cn(
      'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5',
      'text-micro font-medium leading-[1.45] tracking-normal',
      TONE[tone],
      className,
    )}
    {...rest}
  >
    {icon && (
      <span className="shrink-0 opacity-70" aria-hidden="true">
        {icon}
      </span>
    )}
    {children}
  </span>
)
