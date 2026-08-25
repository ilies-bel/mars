/**
 * Payload contracts for the `daemon-health` action-queue family.
 *
 * Family kinds: `low-disk-space`, `daemon-outage`, `daemon-killed`,
 * `health-check-alert`, `observability-store-oversize`, `outbox-lag`.
 *
 * Each interface mirrors exactly what the raiser(s) write into the `payload`
 * field of `raiseActionQueueItem`. The recipe for each kind reads only keys
 * declared here, so a recipe reading a key no raiser emits is a compile error.
 *
 * ## outbox-lag — two raise sites, one contract
 *
 * `outbox-lag` is raised by two separate paths with slightly different shapes:
 *  - `lib/outbox-lag.ts` (`checkOutboxLag`): emits `lag`, `threshold`, `head`, `tail`
 *  - `daemon/outbox-sweeper.ts` (`sweepOutbox`): emits `lag`, `threshold`, `subscriber`
 *
 * `lag` and `threshold` are required (always present). `head`, `tail`, and
 * `subscriber` are optional; each path emits only the fields it has available.
 */

// ── Payload interfaces ────────────────────────────────────────────────────────

/** Raised when the filesystem hosting `.mars/worktrees/` is nearly full. */
export interface LowDiskSpacePayload {
  /** Free bytes remaining on the filesystem at dispatch time. */
  freeBytes: number
  /** Dispatch-refusal threshold in bytes (`MARS_LOW_DISK_THRESHOLD_BYTES`). */
  thresholdBytes: number
}

/** Raised at daemon start when the gap since the last heartbeat exceeds the threshold. */
export interface DaemonOutagePayload {
  /** Outage duration in milliseconds (`Date.now() - lastBeatTs`). */
  outageMs: number
  /** ISO timestamp of the last successful heartbeat before the outage. */
  lastBeatAt: string
  /** ISO timestamp when the outage was detected (current daemon boot). */
  detectedAt: string
  /** Tasks that were in `queued` status when the daemon came back up. */
  strandedTaskCount: number
}

/**
 * Raised for each `failed` task whose `failureSignature` is `'daemon-killed'`.
 *
 * Raise site: `daemon/daemon-killed-sweep.ts` (`detectAndRaiseDaemonKilled`).
 */
export interface DaemonKilledPayload {
  /** Task lifecycle status at alert time (always `'failed'`). */
  status: string
  /** Task branch name, or `null` when not yet assigned at kill time. */
  branch: string | null
  /** Task prompt text — lets the operator recognise which task was killed. */
  prompt: string
  /** Error recorded on the task, or `null` when none was captured. */
  error: string | null
  /** Discriminator: always `'daemon-killed'`. */
  errorKind: 'daemon-killed'
}

/**
 * Raised by the Steward's scheduled health pass and by the merge-step
 * operator-auto-commit probe when a monitored condition requires attention.
 *
 * `conditionKey` is the stable identifier used for dedup and auto-clear.
 * `checkDetails` is check-specific and varies by `conditionKey`.
 */
export interface HealthCheckAlertPayload {
  /** Stable identifier for the condition (used for dedup and auto-clear). */
  conditionKey: string
  /** Human-readable description of the failing condition. */
  message: string
  /** Check-specific detail data; shape varies by `conditionKey`. */
  checkDetails?: unknown
}

/** Raised when `trace_events` in the Mars database exceeds 500 MB. */
export interface ObservabilityStoreOversizePayload {
  /** Raw store size in bytes at detection time. */
  sizeBytes: number
  /** Store size in MB, rounded to one decimal (`sizeBytes / 1_048_576`). */
  sizeMb: number
  /** Warning threshold in MB (always 500). */
  thresholdMb: number
}

/**
 * Raised when the event-outbox lag exceeds the configured threshold.
 *
 * Two raise paths share this kind; `lag` and `threshold` are always present:
 *  - `checkOutboxLag` (`lib/outbox-lag.ts`): also emits `head` and `tail`
 *  - `sweepOutbox` (`daemon/outbox-sweeper.ts`): also emits `subscriber`
 */
export interface OutboxLagPayload {
  /** Lag: `MAX(events.id) − MIN(subscribers.cursor)`. */
  lag: number
  /** Alert threshold (`MARS_OUTBOX_LAG_WARN_THRESHOLD`). */
  threshold: number
  /** Head event id — present when raised by `checkOutboxLag`. */
  head?: number
  /** Tail subscriber cursor — present when raised by `checkOutboxLag`. */
  tail?: number
  /** Name of the wedged subscriber — present when raised by `sweepOutbox`. */
  subscriber?: string
}

// ── Contracts map ─────────────────────────────────────────────────────────────

/** Kind-to-payload map for intersection into `AuditedPayloads`. */
export interface DaemonHealthContracts {
  'low-disk-space': LowDiskSpacePayload
  'daemon-outage': DaemonOutagePayload
  'daemon-killed': DaemonKilledPayload
  'health-check-alert': HealthCheckAlertPayload
  'observability-store-oversize': ObservabilityStoreOversizePayload
  'outbox-lag': OutboxLagPayload
}

// ── Representative payloads ───────────────────────────────────────────────────

/**
 * One representative payload per kind in this family.
 *
 * Each entry mirrors a payload a real raiser would produce, so the contract
 * test can verify the recipe only reads keys the raiser actually emits.
 */
export const REPRESENTATIVE_PAYLOADS: Record<keyof DaemonHealthContracts, Record<string, unknown>> = {
  'low-disk-space': {
    freeBytes: 512 * 1024 * 1024,
    thresholdBytes: 1024 * 1024 * 1024,
  },
  'daemon-outage': {
    outageMs: 45 * 60_000,
    lastBeatAt: '2026-08-24T10:00:00.000Z',
    detectedAt: '2026-08-24T10:45:00.000Z',
    strandedTaskCount: 3,
  },
  'daemon-killed': {
    status: 'failed',
    branch: 'task/mars-abc12345',
    prompt: 'Implement the feature',
    error: null,
    errorKind: 'daemon-killed',
  },
  'health-check-alert': {
    conditionKey: 'operator-auto-commit-typecheck',
    message: 'Typecheck failed on main after auto-commit abc123456',
    checkDetails: { branch: 'main', commitSha: 'abc123456789' },
  },
  'observability-store-oversize': {
    sizeBytes: 600 * 1024 * 1024,
    sizeMb: 600,
    thresholdMb: 500,
  },
  'outbox-lag': {
    lag: 150,
    threshold: 100,
    head: 250,
    tail: 100,
    subscriber: 'prune-sweeper',
  },
}
