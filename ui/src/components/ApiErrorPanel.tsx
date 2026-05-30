import { useEffect } from 'react'
import { logFallbackError } from '@/shared/uiFallback'

interface ApiErrorPanelProps {
  error: string
}

/**
 * Prominent full-pane error banner shown when an API fetch fails and there is
 * no stale data to display.
 *
 * In production, only a calm one-line message is shown — no diagnostics, no
 * shell hints, nothing logged.  In dev mode, the raw error text and a
 * remediation hint are shown and the error is written to the console so the
 * operator can diagnose the problem immediately.
 */
export const ApiErrorPanel = ({ error }: ApiErrorPanelProps) => {
  useEffect(() => {
    logFallbackError(error)
  }, [error])

  return (
    <div
      role="alert"
      data-testid="api-error-panel"
      className="flex h-full flex-col items-center justify-center px-6 text-center"
    >
      <div className="max-w-lg border border-iron/40 bg-iron/10 p-6 font-mono text-left">
        <p className="text-[13px] uppercase tracking-wide text-fg">
          Can&apos;t reach the dashboard server right now.
        </p>
        {import.meta.env.DEV && (
          <>
            <p className="mt-3 whitespace-pre-wrap break-all text-[11px] text-iron">
              {error}
            </p>
            <p className="mt-4 text-[11px] text-iron/70">
              How to fix: run{' '}
              <code className="rounded bg-iron/20 px-1">npm run dev:server</code>{' '}
              in the{' '}
              <code className="rounded bg-iron/20 px-1">ui/</code>{' '}
              directory, or{' '}
              <code className="rounded bg-iron/20 px-1">npm run dev:all</code> to
              start both the UI and API server together.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
