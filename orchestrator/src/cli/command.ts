/**
 * The CLI Command seam (ADR-0023).
 *
 * The unit of the seam is the LEAF — each invocable path ('task add',
 * 'glossary set', 'where') is one {@link Command}, registered by its full path
 * in a flat path-keyed registry (see `registry.ts`). The 'task'/'proposal'/
 * 'glossary' grouping is computed routing (group by path[0] for help and
 * discovery), not an object and not a unit.
 *
 * Every Command's `run(args, deps)` returns a {@link CommandResult} — it never
 * calls `process.exit` and never touches `console`. The production adapter
 * (`cli.ts`) maps `result.code` to `process.exit` at exactly one site and
 * writes `result.value` to stdout; the in-process test adapter
 * (`test-adapter.ts`) asserts on the returned `CommandResult` directly with an
 * injected `:memory:` store and a fake daemon-client — no spawning, no
 * `process.exit`.
 *
 * Capabilities arrive via injected {@link CommandDeps}: the swappable seams a
 * test must control are `store` (the ADR-0021 TaskStore) and `daemon`
 * (`sendRequest`); `ctx`, `out`, and `err` round out the surface. Transport
 * (local read vs daemon-routed mutation) is the injected `daemon` dependency,
 * never a Command taxonomy — it varies per-subcommand, not per-command.
 */

import type { OrchestratorContext } from '../core/context'
import type { DomainTaskStore } from '../core/store/task-store'
import type { DaemonRequest } from '../core/daemon/protocol'
import type { ParsedArgs } from './args'

/**
 * The daemon-client transport seam as the Command layer sees it. This is a
 * structural subset of `core/daemon/client`'s `sendRequest` — narrowed to what
 * Commands call so the in-process test adapter can supply a fake without
 * pulling in the real socket machinery.
 */
export interface DaemonClient {
  sendRequest(
    req: DaemonRequest,
    opts?: {
      autoSpawn?: boolean
      onSpawnNotice?: (pid: number, logFile: string) => void
      /** Repo root override forwarded to the daemon transport so the socket
       *  path is resolved under `<repo>/.mars/` rather than CWD/MARS_REPO. */
      repo?: string
    },
  ): Promise<unknown>
}

/**
 * The capabilities injected into every Command. Two of these are the genuine
 * testability seams (`store`, `daemon`); the rest are ambient context and I/O
 * sinks.
 *
 * `stateStore` is reserved for the StateStore seam (ADR-0021's sibling) and is
 * optional until that seam lands; no current Command requires it.
 */
export interface CommandDeps {
  /** The injected domain TaskStore (ADR-0021). `:memory:` in tests. */
  store: DomainTaskStore
  /** Reserved for the StateStore seam; optional until that seam lands. */
  stateStore?: unknown
  /** The daemon-routed-mutation transport seam. A fake in tests. */
  daemon: DaemonClient
  /** Resolved repo/state context. */
  ctx: OrchestratorContext
  /** stdout sink — replaces `console.log`. */
  out: (s: string) => void
  /** stderr sink — replaces `console.error`. */
  err: (s: string) => void
}

/**
 * The outcome of running a Command. `code` is the process exit code the
 * production adapter maps to `process.exit`; `value` is an optional structured
 * payload the test adapter can assert on (most commands write all
 * user-visible output through `deps.out`/`deps.err` and leave `value`
 * undefined).
 */
export interface CommandResult {
  code: number
  value?: unknown
}

/**
 * A single invocable leaf. `path` is the full space-joined leaf path
 * ('task add', 'glossary set', 'where'); `summary` and `usage` feed help and
 * discovery; `run` does the work and returns a {@link CommandResult}.
 */
export interface Command {
  /** Full leaf path, e.g. 'task add' or 'where'. */
  path: string
  /** One-line description for grouped help/discovery. */
  summary: string
  /** Usage string (the `usage: …` line emitted on bad input). */
  usage: string
  /** Optional longer explanation for commands whose summary is insufficient. */
  helpBody?: string
  /** Human-readable descriptions of the command's flags. */
  flags?: readonly CommandFlag[]
  run(
    args: ParsedArgs,
    deps: CommandDeps,
  ): Promise<CommandResult> | CommandResult
}

/** One documented command-line flag. */
export interface CommandFlag {
  syntax: string
  description: string
}

/** Convenience constructor for the common `{ code }` result. */
export const ok = (value?: unknown): CommandResult => ({ code: 0, value })
export const fail = (code = 1): CommandResult => ({ code })
