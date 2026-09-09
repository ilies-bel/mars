import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A native `<select>` wearing the app's chrome.
 *
 * Five surfaces shipped a bare `<select>` with `appearance: auto`, at two
 * different heights and two different radii. In an app where every other
 * control is custom-drawn, the unstyled OS dropdown is the loudest possible
 * tell that nobody looked at the page — it brings the platform's own font,
 * border, radius and arrow, none of which match anything around it.
 *
 * This stays a real `<select>` on purpose: it keeps native keyboard handling,
 * type-ahead, and the platform picker on touch devices, which a div-based
 * listbox has to reimplement and usually gets wrong. Only the chrome is
 * replaced — `appearance-none` plus our own chevron.
 */
export interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /**
   * Matches ActionButton's ramp so a select can sit in a row of buttons.
   * Named `scale`, not `size`: `size` on a native <select> is the number of
   * visible rows, and shadowing it would silently drop a real HTML attribute.
   */
  scale?: 'sm' | 'md'
}

export const SelectField = ({
  scale = 'md',
  className,
  children,
  ...rest
}: SelectFieldProps) => (
  <div className="relative inline-flex min-w-0 shrink-0 items-center">
    <select
      className={cn(
        'w-full min-w-0 cursor-pointer appearance-none truncate rounded-md border border-border bg-surface',
        'font-medium text-foreground shadow-[var(--shadow-e1)]',
        'transition-[border-color,box-shadow,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'hover:bg-background focus:border-highlight/50',
        'disabled:pointer-events-none disabled:opacity-45',
        scale === 'sm' ? 'h-6 pl-2 pr-7 text-micro' : 'h-7 pl-2.5 pr-8 text-label',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
    <ChevronDown
      size={scale === 'sm' ? 12 : 13}
      strokeWidth={1.75}
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute text-muted-foreground',
        scale === 'sm' ? 'right-1.5' : 'right-2',
      )}
    />
  </div>
)
