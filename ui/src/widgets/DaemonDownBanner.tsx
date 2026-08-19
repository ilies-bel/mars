/**
 * DaemonDownBanner — the one unmissable statement that Mars is not running.
 *
 * When the daemon is down every page is showing stale or empty data, so this
 * belongs in the shell rather than in any single page: whichever route the
 * operator happens to be on, the reason the screen looks quiet is the same, and
 * they should not have to infer it from a blank list.
 *
 * Renders nothing while the daemon is healthy, so it costs no vertical space in
 * the normal case.
 */

import { useDaemonHealth } from '@/entities/daemon/useDaemonHealth'

export const DAEMON_DOWN_MESSAGE = "Can't reach the Mars daemon"

export const DaemonDownBanner = () => {
  const { isDown, isUiServerUnreachable } = useDaemonHealth()

  if (!isDown && !isUiServerUnreachable) return null

  const { message, remedy } = isUiServerUnreachable
    ? {
        message: "Can't reach the mars-ui server",
        remedy: 'mars ui',
      }
    : {
        message: DAEMON_DOWN_MESSAGE,
        remedy: 'mars daemon start',
      }

  return (
    <div
      role="alert"
      data-testid="daemon-down-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-error/40 bg-error/10 px-4 py-1.5"
    >
      <span className="font-mono text-label font-semibold text-error">
        {message}
      </span>
      <span className="font-mono text-micro text-muted-foreground">
        — everything below is stale or empty until it is back. Start it with
      </span>
      <code className="rounded bg-error/15 px-1.5 py-0.5 font-mono text-micro text-error">
        {remedy}
      </code>
    </div>
  )
}
