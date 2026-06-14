/**
 * Tiny leveled logger for bus library code.
 *
 * Reads `BUS_LOG_LEVEL` from the environment (debug|info|warn|error).
 * Defaults to `info`. Writes to stderr so stdout stays clean for any
 * future pipe-based wire protocols.
 *
 * An optional structured sink can be registered via `setBusLogSink`. When
 * set, each log entry is also forwarded to the sink (fire-and-forget for
 * async sinks — the sink is responsible for error handling). Errors thrown
 * synchronously by the sink are silently swallowed so a trace-store hiccup
 * never propagates into bus logging. The sink is never called inside the
 * catch handler to prevent recursion.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Shape of an entry forwarded to the optional bus log sink. */
export interface BusLogEntry {
  level: LogLevel;
  msg: string;
  /** Present when `meta` was supplied to `log()`. */
  fields?: unknown;
}

/** A sync callback that receives every bus log entry that passes the level filter. */
export type BusLogSink = (entry: BusLogEntry) => void;

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let _busLogSink: BusLogSink | null = null;

/**
 * Register an optional sink to receive bus log entries in addition to the
 * default stderr output. Pass `null` to clear the sink. The sink is called
 * synchronously after the stderr write; if the sink fires an async operation
 * (e.g. a database write) it must handle its own error catching internally.
 *
 * Typical daemon wiring:
 * ```ts
 * setBusLogSink(({ level, msg, fields }) => {
 *   traceStore.record({ kind: 'log_line', payload: { level, msg, source: 'bus', fields } })
 *     .catch(() => {})
 * })
 * ```
 */
export function setBusLogSink(sink: BusLogSink | null): void {
  _busLogSink = sink;
}

function currentLevel(): number {
  const raw = (process.env.BUS_LOG_LEVEL ?? 'info').toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

/**
 * Emit a structured log line if `level` is at or above the configured
 * threshold. `meta` is rendered as JSON when present.
 *
 * When a sink is registered via `setBusLogSink`, the entry is also forwarded
 * to the sink. Sync errors from the sink are swallowed (no log-in-catch).
 */
export function log(level: LogLevel, msg: string, meta?: unknown): void {
  if (LEVELS[level] < currentLevel()) return;
  const ts = new Date().toISOString();
  const tag = `[bus ${level}]`;
  if (meta !== undefined) {
    process.stderr.write(`${ts} ${tag} ${msg} ${JSON.stringify(meta)}\n`);
  } else {
    process.stderr.write(`${ts} ${tag} ${msg}\n`);
  }
  if (_busLogSink !== null) {
    const entry: BusLogEntry =
      meta !== undefined ? { level, msg, fields: meta } : { level, msg };
    try {
      _busLogSink(entry);
    } catch {
      // Swallow — a sink error must never throw into bus logging.
      // No log() call here to prevent recursion.
    }
  }
}
