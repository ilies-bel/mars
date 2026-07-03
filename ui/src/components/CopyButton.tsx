import { useCallback, useEffect, useRef, useState } from 'react'

interface CopyButtonProps {
  /** Text written to the clipboard on click. */
  text: string
  /**
   * Button label (default: `'Copy'`). After a successful copy the button
   * shows `'Copied ✓'` for 1 500 ms, then reverts to this label.
   */
  label?: string
  /** Tailwind class string. Defaults to the standard inline-copy button look. */
  className?: string
  'data-testid'?: string
  'aria-label'?: string
}

/**
 * A clipboard copy button with a transient "Copied ✓" confirmation.
 *
 * - Uses `navigator.clipboard.writeText` with a `typeof navigator` guard so
 *   it degrades gracefully in SSR / jsdom environments.
 * - Clipboard errors are swallowed silently — the button is error-tolerant.
 * - The timer is cleared on unmount to prevent `setState`-after-unmount.
 */
export function CopyButton({
  text,
  label = 'Copy',
  className = 'shrink-0 rounded border border-iron/40 px-2 py-0.5 font-mono text-xs text-iron hover:bg-iron/10',
  'data-testid': testId,
  'aria-label': ariaLabel,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  const handleClick = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    navigator.clipboard.writeText(text).then(
      () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        setCopied(true)
        timerRef.current = setTimeout(() => {
          setCopied(false)
          timerRef.current = null
        }, 1500)
      },
      () => {
        // Clipboard write failed — swallow silently.
      },
    )
  }, [text])

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel ?? `Copy: ${text}`}
      onClick={handleClick}
      className={className}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  )
}
