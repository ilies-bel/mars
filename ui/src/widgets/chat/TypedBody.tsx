import { useLayoutEffect, useRef, useState } from 'react'

/**
 * Ids whose body has already been revealed in this browser session.
 *
 * Module-level on purpose: the operator switching tabs unmounts the timeline,
 * and a message must not retype itself every time they come back. Only a
 * genuinely new arrival types.
 */
const revealed = new Set<string>()

/** Mark ids as already seen, so a page load does not retype the whole backlog. */
export const markRevealed = (ids: Iterable<string>): void => {
  for (const id of ids) revealed.add(id)
}

/** Test seam — the reveal set is process-global, so suites must reset it. */
export const resetRevealed = (): void => {
  revealed.clear()
}

/** Characters added per tick. Faster than a human, slower than a paste. */
const CHARS_PER_TICK = 3
const TICK_MS = 16

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export interface TypedBodyProps {
  /** Stable message id — the identity the reveal is remembered against. */
  id: string
  text: string
  className?: string
}

/**
 * A Notice body that reads as speech rather than as a log line.
 *
 * Notices are pre-written strings, not token streams, so the reveal is
 * cosmetic — the message is already durable in the database before the first
 * character appears. That is why this never gates anything: the chips beneath
 * it render immediately, and any failure to animate leaves the full text on
 * screen rather than an empty card.
 *
 * State starts at the complete text and the effect empties it, rather than
 * starting empty and filling. That ordering is what makes server rendering and
 * `prefers-reduced-motion` fall out for free: no effect runs, so the text is
 * simply there.
 */
export const TypedBody = ({ id, text, className }: TypedBodyProps) => {
  const [shown, setShown] = useState(text)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useLayoutEffect(() => {
    if (revealed.has(id)) return
    if (prefersReducedMotion()) {
      revealed.add(id)
      return
    }

    setShown('')
    let cursor = 0
    timerRef.current = setInterval(() => {
      cursor += CHARS_PER_TICK
      if (cursor >= text.length) {
        setShown(text)
        // Marked done only on completion. Marking on *start* looks equivalent
        // but is not: React re-runs layout effects on mount in development,
        // and a message already flagged as revealed would skip its own
        // animation and appear pasted.
        revealed.add(id)
        if (timerRef.current !== null) clearInterval(timerRef.current)
        timerRef.current = null
        return
      }
      setShown(text.slice(0, cursor))
    }, TICK_MS)

    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [id, text])

  return (
    <p className={className} data-testid={`typed-body-${id}`}>
      {shown}
    </p>
  )
}
