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
type ActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
type ActionSize = 'sm' | 'md'

const VARIANT: Record<ActionVariant, string> = {
  primary:
    'bg-highlight text-white shadow-[var(--shadow-e1)] hover:bg-highlight/90 active:bg-highlight',
  secondary:
    'border border-border bg-surface text-foreground shadow-[var(--shadow-e1)] hover:border-border hover:bg-background active:bg-border/40',
  ghost:
    'border border-transparent text-muted-foreground hover:border-border hover:bg-foreground/5 hover:text-foreground active:bg-foreground/10',
  danger:
    'border border-error/25 bg-transparent text-error hover:border-error/60 hover:bg-error/10 active:bg-error/20',
  // For a destructive verb repeated down a list. `danger` puts error-red text
  // on every row, and twelve red words in a column stop reading as a warning
  // and start reading as decoration. This one is neutral until pointed at.
  // The border is why it is not "bare text": a destructive action must have a
  // bounding box you can aim at even while it is being visually quiet.
  // The border is error-tinted AT REST. It was `border-border/70`, which made
  // this rung differ from `ghost` only by the presence of a hairline — so on
  // the Gates list "Retire" (permanent) and "Quarantine" (reversible) were
  // indistinguishable until you pointed at one, and a destructive action you
  // can only identify by hovering is not identified. The tint is quiet enough
  // that twelve of them down a column still do not shout, and the label text
  // carries the meaning independently of colour.
  'danger-ghost':
    'border border-error/30 text-muted-foreground hover:border-error/60 hover:bg-error/10 hover:text-error active:bg-error/20',
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
