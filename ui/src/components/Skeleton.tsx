/**
 * Shared skeleton primitives for loading states.
 *
 * Built on `bg-iron/20` and `.animate-mars-pulse` (not Tailwind's
 * `animate-pulse`) so the animation respects `prefers-reduced-motion`.
 *
 * Usage:
 *   <SkeletonBlock className="h-4 w-1/2" />
 *   <SkeletonList rows={3} rowClassName="h-4 w-full mb-2" label="Loading items" />
 */

interface SkeletonBlockProps {
  /** Tailwind classes for size, spacing, and any per-bar overrides. */
  className?: string
}

/**
 * A single pulsing bar. Use `className` to control height, width, and spacing.
 */
export const SkeletonBlock = ({ className = '' }: SkeletonBlockProps) => (
  <div className={`animate-mars-pulse rounded bg-iron/20 ${className}`} />
)

interface SkeletonListProps {
  /** Number of skeleton bars to render. */
  rows: number
  /**
   * Tailwind classes applied to every bar.
   * Typically includes height and width (e.g. "h-4 w-full mb-2").
   */
  rowClassName?: string
  /**
   * Accessible label for the loading region — announced by screen readers.
   * Defaults to "Loading".
   */
  label?: string
  /** Extra classes on the wrapper element (e.g. layout/spacing). */
  className?: string
}

/**
 * Renders `rows` SkeletonBlock elements inside an `aria-busy` container.
 * The container announces the loading state to screen readers via `aria-label`.
 */
export const SkeletonList = ({
  rows,
  rowClassName = '',
  label = 'Loading',
  className,
}: SkeletonListProps) => (
  <div aria-busy="true" aria-label={label} className={className}>
    {Array.from({ length: rows }, (_, i) => (
      <SkeletonBlock key={i} className={rowClassName} />
    ))}
  </div>
)
