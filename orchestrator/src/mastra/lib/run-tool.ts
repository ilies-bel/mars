import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type {
  TraceEventPhase,
  TraceEventStore,
} from './trace-events-store'

/**
 * `runTool` — the single entry point for every shell invocation issued by
 * the orchestrator's workflow phases (setup / code / verify / merge).
 *
 * - Spawns via `node:child_process` `spawn`. Argv only; never a shell string.
 * - Captures stdout/stderr as utf-8 strings.
 * - On exit, writes one `tool_invoked` trace event with the truncated
 *   stdout/stderr (8 KB cap, head+tail join when truncated) plus tool name,
 *   argv, exit code, duration, and `expectsFailure` flag.
 * - The CALLER receives the full untruncated stdout/stderr in the return value.
 * - SIGTERM → SIGKILL on `timeoutMs`. On timeout, stderr in both the trace and
 *   the result is suffixed with `\n[runTool: killed after <ms>ms]` so the kill
 *   is unambiguous in post-mortems.
 *
 * Severity for the trace event is derived by `deriveSeverity` in
 * `trace-events-store.ts`: zero exit → info; non-zero with `expectsFailure:
 * true` → warn; non-zero otherwise → error.
 *
 * NOT for the worker subprocess's own internal tool calls — those are
 * captured in Anthropic's transcript via the worker's sessionId. `runTool`
 * exists to instrument the orchestrator's OWN shell-outs.
 */

export interface RunToolInput {
  /** Short, stable name for the tool. Examples: 'git', 'npm', 'gh'.
   *  Not the argv[0] of an arbitrary script — a logical name. */
  tool: string
  /** Argv array. Never a shell string. */
  argv: string[]
  /** Working directory for the invocation. */
  cwd: string
  /** Trace context. */
  taskId?: string | null
  originId?: string | null
  phase?: TraceEventPhase | null
  /** Optional env overrides; merged onto process.env. */
  env?: Record<string, string>
  /** Soft cap in ms after which the child is SIGTERM'd then SIGKILL'd.
   *  Default: no timeout. */
  timeoutMs?: number
  /** When true, a non-zero exit is `warn` (expected-failure path),
   *  not `error`. Used for probes like `git status` where non-zero is
   *  meaningful but not a crisis. Default false. */
  expectsFailure?: boolean
}

export interface RunToolResult {
  exitCode: number
  /** Full stdout. Untruncated; truncation is for the trace event only. */
  stdout: string
  stderr: string
  durationMs: number
  /** The trace event id that was written. */
  traceEventId: string
}

const HEAD_TAIL_BYTES = 4 * 1024
const TRUNCATE_CAP_BYTES = 8 * 1024
const SIGKILL_GRACE_MS = 2_000

/**
 * Bound a stdout/stderr capture for the trace payload. When the string
 * exceeds the 8 KB cap, keep the first 4 KB and the last 4 KB joined by
 * `\n...truncated <N bytes>...\n` so the prologue and the tail (where the
 * actual error usually lives) both survive.
 */
export const truncateForTrace = (raw: string): string => {
  const buf = Buffer.from(raw, 'utf8')
  if (buf.byteLength <= TRUNCATE_CAP_BYTES) return raw
  const head = buf.subarray(0, HEAD_TAIL_BYTES).toString('utf8')
  const tail = buf.subarray(buf.byteLength - HEAD_TAIL_BYTES).toString('utf8')
  const dropped = buf.byteLength - HEAD_TAIL_BYTES * 2
  return `${head}\n...truncated ${dropped} bytes...\n${tail}`
}

export const runTool = async (
  input: RunToolInput,
  store: TraceEventStore,
): Promise<RunToolResult> => {
  const expectsFailure = input.expectsFailure === true
  const traceEventId = randomUUID()
  const start = performance.now()

  // Spawn first so that ENOENT / EACCES surfaces here as an Error, NOT as a
  // silent `tool_invoked` trace with a synthesised exit code. The contract:
  // "argv with a non-existent binary throws cleanly".
  const child = spawn(input.tool, input.argv, {
    cwd: input.cwd,
    env: { ...process.env, ...(input.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let sigkillHandle: ReturnType<typeof setTimeout> | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })

  const exitInfo = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    spawnError?: NodeJS.ErrnoException
  }>((resolveFn) => {
    let settled = false
    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: NodeJS.ErrnoException,
    ): void => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (sigkillHandle) clearTimeout(sigkillHandle)
      resolveFn({ code, signal, spawnError })
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(null, null, err)
    })
    child.on('close', (code, signal) => {
      settle(code, signal)
    })

    if (
      input.timeoutMs !== undefined &&
      input.timeoutMs > 0 &&
      Number.isFinite(input.timeoutMs)
    ) {
      const ms = input.timeoutMs
      timeoutHandle = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGTERM')
        } catch {
          // process already gone
        }
        sigkillHandle = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // process already gone
          }
        }, SIGKILL_GRACE_MS)
      }, ms)
    }
  })

  const durationMs = performance.now() - start

  // Spawn-time failures (ENOENT / EACCES) throw cleanly so the caller learns
  // about a missing binary instead of silently writing a bogus trace.
  if (exitInfo.spawnError) {
    const err = exitInfo.spawnError
    const detail = err.code ? `${err.code}: ${err.message}` : err.message
    const wrapped = new Error(
      `runTool: spawn ${input.tool} failed (${detail})`,
    )
    ;(wrapped as Error & { cause?: unknown }).cause = err
    throw wrapped
  }

  // Resolve the effective exit code. Node maps signal exits to (null, signal);
  // surface the conventional 128+signo so callers and the trace agree.
  const resolveExitCode = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): number => {
    if (code !== null) return code
    if (signal === 'SIGTERM') return 143
    if (signal === 'SIGKILL') return 137
    if (signal !== null) return 128
    return 1
  }
  const exitCode = resolveExitCode(exitInfo.code, exitInfo.signal)

  // Suffix the timeout marker so the kill is unambiguous in the trace AND in
  // the caller's stderr. The caller's stdout is left untouched.
  if (timedOut) {
    const marker = `[runTool: killed after ${input.timeoutMs}ms]`
    const sep = stderr.length === 0 || stderr.endsWith('\n') ? '' : '\n'
    stderr = `${stderr}${sep}${marker}\n`
  }

  const truncatedStdout = truncateForTrace(stdout)
  const truncatedStderr = truncateForTrace(stderr)

  await store.record({
    kind: 'tool_invoked',
    taskId: input.taskId ?? null,
    originId: input.originId ?? null,
    phase: input.phase ?? null,
    payload: {
      id: traceEventId,
      tool: input.tool,
      argv: input.argv,
      exitCode,
      durationMs,
      stdout: truncatedStdout,
      stderr: truncatedStderr,
      expectsFailure,
    },
  })

  return {
    exitCode,
    stdout,
    stderr,
    durationMs,
    traceEventId,
  }
}

/**
 * Trace context piped through library functions that wrap `runTool`.
 *
 * Libraries reached from inside a workflow (e.g. `git.ts`) take an optional
 * `TraceCtx` so the trace event records the originating task and phase. CLI
 * call sites (no task in scope) pass `undefined` and the lib falls through to
 * a no-op trace store (see `nullTraceStore`).
 */
export interface TraceCtx {
  taskId?: string | null
  originId?: string | null
  phase?: TraceEventPhase | null
  store: TraceEventStore
}

/**
 * Trace store that drops every record() call. Used by lib callers outside a
 * workflow (CLI admin commands, tests) to keep the `runTool` API uniform
 * without writing a bogus trace event.
 */
export const nullTraceStore: TraceEventStore = {
  record: async () => {},
  query: async () => [],
  close: async () => {},
}
