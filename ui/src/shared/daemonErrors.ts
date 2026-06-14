/** Wire-contract error codes the UI server attaches to daemon-connectivity failures. */
export const DAEMON_ERROR = {
  /** No `.mars/http.port` file — the daemon is not running. HTTP 503. */
  NO_DAEMON: 'NO_DAEMON',
  /** Port file present but the fetch to the daemon threw. HTTP 502. */
  PROXY_FAILED: 'PROXY_FAILED',
} as const
export type DaemonErrorCode = (typeof DAEMON_ERROR)[keyof typeof DAEMON_ERROR]
