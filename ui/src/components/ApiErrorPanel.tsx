import { ApiError } from '@/shared/api'

interface ApiErrorPanelProps {
  error: ApiError | Error | string
}

/**
 * Prominent full-pane error banner shown when an API fetch fails and there is
 * no stale data to display. Shows different remedies depending on the error
 * kind:
 *
 * - `stale-daemon` (HTTP 404/405 with JSON body): the daemon predates the
 *   route — restart with `mars daemon restart`.
 * - Everything else: the API server is not running — start it with
 *   `npm run dev:server` / `npm run dev:all`.
 */
export const ApiErrorPanel = ({ error }: ApiErrorPanelProps) => {
  const message = typeof error === 'string' ? error : error.message
  const isStaleDaemon =
    error instanceof ApiError && error.kind === 'stale-daemon'

  return (
    <div
      role="alert"
      data-testid="api-error-panel"
      className="flex h-full flex-col items-center justify-center px-6 text-center"
    >
      <div className="max-w-lg border border-iron/40 bg-iron/10 p-6 font-mono text-left">
        <p className="text-[13px] uppercase tracking-wide text-fg">
          API server not reachable
        </p>
        <p className="mt-3 whitespace-pre-wrap break-all text-[11px] text-iron">
          {message}
        </p>
        {isStaleDaemon ? (
          <p className="mt-4 text-[11px] text-iron/70">
            How to fix: the daemon is likely stale — restart it with:{' '}
            <code className="rounded bg-iron/20 px-1">mars daemon restart</code>
          </p>
        ) : (
          <p className="mt-4 text-[11px] text-iron/70">
            How to fix: run{' '}
            <code className="rounded bg-iron/20 px-1">npm run dev:server</code>{' '}
            in the <code className="rounded bg-iron/20 px-1">ui/</code>{' '}
            directory, or{' '}
            <code className="rounded bg-iron/20 px-1">npm run dev:all</code> to
            start both the UI and API server together.
          </p>
        )}
      </div>
    </div>
  )
}
