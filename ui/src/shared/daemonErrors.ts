/** Wire-contract error codes the UI server attaches to daemon-connectivity failures. */
export const DAEMON_ERROR = {
  /** No `.mars/http.port` file — the daemon is not running. HTTP 503. */
  NO_DAEMON: 'NO_DAEMON',
  /** Port file present but the fetch to the daemon threw. HTTP 502. */
  PROXY_FAILED: 'PROXY_FAILED',
  /**
   * Daemon is reachable but did not return a response within the proxy timeout.
   * HTTP 504. Indicates a hanging route on the daemon side; the caller should
   * surface this as a transient error rather than a permanent failure.
   */
  PROXY_TIMEOUT: 'PROXY_TIMEOUT',
  /**
   * Daemon is running but its code predates the requested route (404/405) and
   * the daemon reports that HEAD has advanced since it started (isStale=true).
   * Remedy: `mars daemon restart`. The response body carries `sourceSha` and
   * `currentSha` (7-char short SHAs) to make the message verifiable.
   */
  STALE_DAEMON_CODE: 'STALE_DAEMON_CODE',
} as const
export type DaemonErrorCode = (typeof DAEMON_ERROR)[keyof typeof DAEMON_ERROR]
