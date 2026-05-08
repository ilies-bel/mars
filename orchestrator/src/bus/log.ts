/**
 * Tiny leveled logger for bus library code.
 *
 * Reads `BUS_LOG_LEVEL` from the environment (debug|info|warn|error).
 * Defaults to `info`. Writes to stderr so stdout stays clean for any
 * future pipe-based wire protocols.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): number {
  const raw = (process.env.BUS_LOG_LEVEL ?? 'info').toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

/**
 * Emit a structured log line if `level` is at or above the configured
 * threshold. `meta` is rendered as JSON when present.
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
}
