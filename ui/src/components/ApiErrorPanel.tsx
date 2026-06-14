import { useEffect } from 'react'
import type { ApiErrorKind } from '@/shared/api'
import { logFallbackError } from '@/shared/uiFallback'

interface ApiErrorPanelProps {
  error: string
  /** Discriminant from `ApiError.kind` — drives the dev-mode remedy hint. */
  kind?: ApiErrorKind
}

/**
 * Prominent full-pane error banner shown when an API fetch fails and there is
 * no stale data to display.
 *
 * In production, only a calm one-line message is shown — no diagnostics, no
 * shell hints, nothing logged.  In dev mode, the raw error text and a
 * remediation hint are shown and the error is written to the console so the
 * operator can diagnose the problem immediately.
 *
 * The dev-mode hint branches on `kind`:
 *   - `stale-daemon`  → restart daemon (the UI server is up; daemon port is stale)
 *   - `unreachable`   → start the UI API server (`npm run dev:server`)
 *   - `other`/`undefined` → generic server-error hint
 */
export const ApiErrorPanel = ({ error, kind }: ApiErrorPanelProps) => {
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
            {kind === 'stale-daemon' ? (
              <p className="mt-4 text-[11px] text-iron/70">
                How to fix: run{' '}
                <code className="rounded bg-iron/20 px-1">mars daemon restart</code>
                {' '}— the UI server is up but the daemon&apos;s published port is
                stale or the daemon is not running. You can also use the{' '}
                <strong>Restart daemon</strong> button in the project selector.
              </p>
            ) : kind === 'unreachable' ? (
              <p className="mt-4 text-[11px] text-iron/70">
                How to fix: run{' '}
                <code className="rounded bg-iron/20 px-1">npm run dev:server</code>{' '}
                in the{' '}
                <code className="rounded bg-iron/20 px-1">ui/</code>{' '}
                directory, or{' '}
                <code className="rounded bg-iron/20 px-1">npm run dev:all</code> to
                start both the UI and API server together.
              </p>
            ) : (
              <p className="mt-4 text-[11px] text-iron/70">
                How to fix: check the server logs for more details. If the problem
                persists, try restarting with{' '}
                <code className="rounded bg-iron/20 px-1">mars daemon restart</code>.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
