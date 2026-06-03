/**
 * In-process test adapter for the Command seam (ADR-0023 §2).
 *
 * `runCommandInProcess` parses an argv array, builds {@link CommandDeps} from a
 * caller-supplied store / fake daemon / context, dispatches through the same
 * `registry` and `dispatch` the production adapter uses, and returns the
 * {@link CommandResult} alongside the captured stdout/stderr lines. No process
 * is spawned and `process.exit` is never called — a test asserts on the
 * returned `{ code, value, out, err }`.
 *
 * This is the seam's payoff: every command, including the logic-heavy
 * ladder-bearing ones, is exercisable in-process with a `:memory:`/temp-file
 * store and a recording fake daemon-client.
 */

import { parseArgs } from './args'
import { registry } from './commands'
import { dispatch, isUnknown } from './dispatch'
import type { CommandDeps, DaemonClient } from './command'
import type { DomainTaskStore } from '../core/store/task-store'
import type { OrchestratorContext } from '../core/context'

export interface InProcessResult {
  /** Exit code the production adapter would map to `process.exit`. */
  code: number
  /** Optional structured payload a command may return. */
  value?: unknown
  /** stdout lines (one per `deps.out` call). */
  out: string[]
  /** stderr lines (one per `deps.err` call). */
  err: string[]
  /** True when no leaf matched (router returned unknown). */
  unknown?: boolean
}

/**
 * A recording fake daemon-client. Each `sendRequest` call is captured and a
 * canned response is returned (resolved from `responder`, default `{}`).
 */
export interface FakeDaemon extends DaemonClient {
  readonly calls: ReadonlyArray<Parameters<DaemonClient['sendRequest']>[0]>
}

export const makeFakeDaemon = (
  responder?: (
    req: Parameters<DaemonClient['sendRequest']>[0],
  ) => unknown | Promise<unknown>,
): FakeDaemon => {
  const calls: Array<Parameters<DaemonClient['sendRequest']>[0]> = []
  return {
    calls,
    sendRequest: async (req) => {
      calls.push(req)
      return responder ? responder(req) : {}
    },
  }
}

export interface InProcessOptions {
  store: DomainTaskStore
  daemon: DaemonClient
  ctx: OrchestratorContext
  stateStore?: unknown
}

/**
 * Run a single command in-process. `argv` is the post-`mars` argument vector
 * (e.g. `['task', 'add', 'do the thing']`).
 */
export const runCommandInProcess = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<InProcessResult> => {
  const out: string[] = []
  const err: string[] = []
  const deps: CommandDeps = {
    store: opts.store,
    daemon: opts.daemon,
    ctx: opts.ctx,
    ...(opts.stateStore !== undefined ? { stateStore: opts.stateStore } : {}),
    out: (s: string): void => {
      out.push(s)
    },
    err: (s: string): void => {
      err.push(s)
    },
  }

  const parsed = parseArgs(argv)
  const result = await dispatch(registry, parsed, deps)
  if (isUnknown(result)) {
    return { code: 1, out, err, unknown: true }
  }
  return { code: result.code, value: result.value, out, err }
}
