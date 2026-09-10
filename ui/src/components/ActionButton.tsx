import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The app's action-button ladder.
 *
 * Before this existed, every action surface hand-rolled its own ternary of
 * Tailwind strings and they all landed on the same treatment: a hairline
 * border, a 5%-opacity tint, and 10px mono text. The result was that
 * "Continue" and "Discard task" — a safe primary and an irreversible delete —
 * carried identical visual weight, so the row had no focal point and the
 * destructive verb was as easy to hit as the safe one.
 *
 * The ladder here is deliberately steep, because that is what makes a dense
 * action row scannable:
 *
 *   primary    solid fill + white text. ONE per row. The obvious next step.
 *   secondary  surface fill + hairline. Real alternatives to the primary.
 *   ghost      no chrome until hover. Tertiary/navigational.
 *   danger     quiet at rest (error text only), fills red on hover. A
 *              destructive verb should be findable, never magnetic — loud
 *              red at rest trains people to ignore red.
 *
 * Type is Inter, not mono: these are chrome, and mono in chrome is what made
 * the whole app read as a terminal rather than a product. Mono is reserved
 * for data (ids, shas, commands).
 */
type ActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ActionSize = 'sm' | 'md'

const VARIANT: Record<ActionVariant, string> = {
  primary:
    'bg-highlight text-white shadow-[var(--shadow-e1)] hover:bg-highlight/90 active:bg-highlight',
  secondary:
    'border border-border bg-surface text-foreground shadow-[var(--shadow-e1)] hover:border-border hover:bg-background active:bg-border/40',
  ghost:
    'border border-transparent text-muted-foreground hover:border-border hover:bg-foreground/5 hover:text-foreground active:bg-foreground/10',
  // Transparent border, not a red one — the class list said `border-error/25`
  // while the doc comment above said "quiet at rest (error text only)", and the
  // markup won. On a failed task's card that put a visible red outline on
  // "Restart (wipe & re-run)" and "Discard task" while the reversible "Snooze"
  // beside them had no border at all: the two most-chromed controls on the row
  // were the two that destroy work irrecoverably. The border still appears on
  // hover, where it belongs — by then the pointer has already chosen.
  danger:
    'border border-transparent bg-transparent text-error hover:border-error/60 hover:bg-error/10 active:bg-error/20',
}

const SIZE: Record<ActionSize, string> = {
  sm: 'h-6 gap-1.5 rounded-md px-2 text-micro',
  md: 'h-7 gap-1.5 rounded-md px-2.5 text-label',
}

const base = (variant: ActionVariant, size: ActionSize, className?: string) =>
  cn(
    'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium',
    'transition-[background-color,border-color,color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
    'disabled:pointer-events-none disabled:opacity-45',
    SIZE[size],
    VARIANT[variant],
    className,
  )

const Label = ({ pending, children }: { pending: boolean; children?: ReactNode }) =>
  pending ? <span className="animate-mars-pulse">···</span> : <>{children}</>

export interface ActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionVariant
  size?: ActionSize
  /** Renders a centred ellipsis in place of the label while an action is in flight. */
  pending?: boolean
  children?: ReactNode
}

export const ActionButton = ({
  variant = 'secondary',
  size = 'md',
  pending = false,
  className,
  children,
  disabled,
  ...rest
}: ActionButtonProps) => (
  <button
    type="button"
    disabled={disabled === true || pending}
    aria-busy={pending || undefined}
    className={base(variant, size, className)}
    {...rest}
  >
    <Label pending={pending}>{children}</Label>
  </button>
)

export interface ActionLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ActionVariant
  size?: ActionSize
  children?: ReactNode
}

/**
 * The same rung of the ladder, rendered as an anchor.
 *
 * An action that is genuinely a navigation must be a real <a>: a <button>
 * that sets location breaks middle-click, "copy link", and the browser's own
 * history, and it lies to assistive tech about what will happen.
 */
export const ActionLink = ({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...rest
}: ActionLinkProps) => (
  <a className={base(variant, size, className)} {...rest}>
    {children}
  </a>
)
