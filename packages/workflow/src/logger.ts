/**
 * Structured logging by design.
 *
 * The engine accepts any logger shaped like pino's core surface
 * (`info`, `warn`, `error`, `child`). It ships a `createJsonLogger()` helper
 * so callers that don't already have one get a sane default with zero deps —
 * but there is no hard dependency on pino itself.
 *
 * There is no `console.log` path anywhere in this package; the only writer
 * is the logger you bring (or the default below).
 */

/** A bag of structured fields attached to a log line. */
export type LogFields = Record<string, unknown>;

/**
 * The minimal logger surface the engine relies on. Pino satisfies it
 * directly; so does the bundled `createJsonLogger()` default.
 *
 * Both call shapes pino supports are accepted: `info(msg)` and
 * `info(fields, msg)`.
 */
export interface Logger {
  info(fields: LogFields, msg?: string): void;
  info(msg: string): void;
  warn(fields: LogFields, msg?: string): void;
  warn(msg: string): void;
  error(fields: LogFields, msg?: string): void;
  error(msg: string): void;
  /** Return a logger that prepends `bindings` to every line it emits. */
  child(bindings: LogFields): Logger;
}

function emit(
  level: 'info' | 'warn' | 'error',
  bindings: LogFields,
  arg1: LogFields | string,
  arg2?: string,
): void {
  const fields = typeof arg1 === 'string' ? {} : arg1;
  const msg = typeof arg1 === 'string' ? arg1 : arg2;
  const line = {
    level,
    time: Date.now(),
    ...bindings,
    ...fields,
    ...(msg !== undefined ? { msg } : {}),
  };
  // The single, deliberate stdout writer for the default logger. Callers
  // that want richer behaviour bring their own pino instance instead.
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * A dependency-free, pino-shaped logger that writes newline-delimited JSON
 * to stdout. Swap in real pino by passing it as `logger` to `runWorkflow`.
 */
export function createJsonLogger(bindings: LogFields = {}): Logger {
  return {
    info: (arg1: LogFields | string, arg2?: string) => emit('info', bindings, arg1, arg2),
    warn: (arg1: LogFields | string, arg2?: string) => emit('warn', bindings, arg1, arg2),
    error: (arg1: LogFields | string, arg2?: string) => emit('error', bindings, arg1, arg2),
    child: (extra: LogFields) => createJsonLogger({ ...bindings, ...extra }),
  };
}

/**
 * A logger that drops everything. Useful as a test default so engine unit
 * tests don't spam stdout.
 */
export function silentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
