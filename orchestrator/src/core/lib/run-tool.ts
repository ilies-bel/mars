import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
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
 * - Every child is spawned `detached: true` so it LEADS ITS OWN PROCESS GROUP,
 *   and every kill path signals `-pid` (the whole group) rather than the direct
 *   child. Without this, `npm test` → `vitest` → forks survived the kill: the
 *   direct child died, the grandchildren were reparented to init and kept
 *   burning CPU for hours (see `orphan-reaper.ts` for the incident). The group
 *   is also swept on normal completion, so a runner that backgrounded a helper
 *   cannot leak it.
 *
 * Severity for the trace event is derived by `deriveSeverity` in
 * `trace-events-store.ts`: zero exit → info; non-zero with `expectsFailure:
 * true` → info (probe, not a failure); non-zero otherwise → warn.
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
  /** When aborted, the child is SIGTERM'd then SIGKILL'd after a 2s grace,
   *  mirroring the `timeoutMs` kill path. If already aborted at spawn time the
   *  child is signalled immediately. */
  signal?: AbortSignal
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
    // Lead a new process group so every kill path below can signal the whole
    // subtree (`-pid`). NOT unref'd — the caller still awaits 'close' and
    // streams the output.
    detached: true,
  })

  /**
   * Signal the child's entire process group, falling back to the direct child
   * when the group is unavailable (spawn failed before a pid was assigned, or
   * the group is already empty).
   */
  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (typeof pid === 'number') {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Group already gone, or never created — fall through to the child.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // process already gone
    }
  }

  let stdout = ''
  let stderr = ''
  let timedOut = false
  let sigkillHandle: ReturnType<typeof setTimeout> | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const abortSignal = input.signal

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
    // Escalate SIGTERM → SIGKILL after the grace window, signalling the whole
    // process group both times. Shared by the timeout and the abort-signal
    // paths so both kill semantics are identical.
    //
    // The escalation timer is armed unconditionally and is NOT cleared by a
    // SIGTERM the child chooses to ignore — only by `settle` (i.e. by the
    // process actually closing). A child that swallows SIGTERM therefore
    // always reaches SIGKILL instead of leaving the group alive.
    const killWithGrace = (): void => {
      signalGroup('SIGTERM')
      if (!sigkillHandle) {
        sigkillHandle = setTimeout(() => {
          signalGroup('SIGKILL')
        }, SIGKILL_GRACE_MS)
      }
    }
    const onAbort = (): void => {
      killWithGrace()
    }
    const settle = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError?: NodeJS.ErrnoException,
    ): void => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (sigkillHandle) clearTimeout(sigkillHandle)
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      resolveFn({ code, signal, spawnError })
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle(null, null, err)
    })
    child.on('close', (code, signal) => {
      settle(code, signal)
    })

    // Abort path: kill the child on caller abort (immediately if already
    // aborted at spawn time), mirroring the timeout kill escalation.
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort()
      } else {
        abortSignal.addEventListener('abort', onAbort)
      }
    }

    if (
      input.timeoutMs !== undefined &&
      input.timeoutMs > 0 &&
      Number.isFinite(input.timeoutMs)
    ) {
      const ms = input.timeoutMs
      timeoutHandle = setTimeout(() => {
        timedOut = true
        killWithGrace()
      }, ms)
    }
  })

  const durationMs = performance.now() - start

  // Completion sweep. The direct child has closed, but a runner that forked
  // workers or backgrounded a helper can leave descendants alive in the group;
  // those are exactly the processes that get reparented to init and burn CPU
  // for hours. Probe the group and, if anything survived, SIGTERM it and
  // escalate to SIGKILL after the grace window. Not awaited (the caller must
  // not pay the grace on every invocation) and the timer is unref'd so it can
  // never hold the daemon's event loop open.
  const finishedPid = child.pid
  if (typeof finishedPid === 'number' && exitInfo.spawnError === undefined) {
    const groupAlive = (): boolean => {
      try {
        process.kill(-finishedPid, 0)
        return true
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    if (groupAlive()) {
      try {
        process.kill(-finishedPid, 'SIGTERM')
      } catch {
        // group drained between the probe and the signal
      }
      setTimeout(() => {
        if (!groupAlive()) return
        try {
          process.kill(-finishedPid, 'SIGKILL')
        } catch {
          // group drained during the grace window
        }
      }, SIGKILL_GRACE_MS).unref()
    }
  }

  // Spawn-time failures (ENOENT / EACCES) throw cleanly so the caller learns
  // about a missing binary instead of silently writing a bogus trace.
  if (exitInfo.spawnError) {
    const err = exitInfo.spawnError
    // Distinguish two ENOENT causes — Node emits the same code for both:
    //   (a) binary not on PATH: cwd exists but the binary was not found.
    //   (b) cwd missing: the spawn cwd directory itself does not exist.
    // Check the cwd on disk to tell them apart so post-mortems can immediately
    // identify a deleted worktree rather than suspecting a PATH misconfiguration.
    let detail: string
    if (err.code === 'ENOENT' && !existsSync(input.cwd)) {
      detail = `working directory no longer exists: ${input.cwd}`
    } else {
      detail = err.code ? `${err.code}: ${err.message}` : err.message
    }
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
