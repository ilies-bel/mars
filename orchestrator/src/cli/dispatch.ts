/**
 * Shared dispatch core for both adapters (ADR-0023 §2).
 *
 * `dispatch` takes a {@link CommandRegistry}, the parsed args, and the injected
 * {@link CommandDeps}, routes to a leaf, and returns its {@link CommandResult}.
 * Neither adapter calls `process.exit` here; the production adapter maps the
 * returned `code` to exit at exactly one site, and the test adapter asserts on
 * the returned result.
 *
 * `makeProductionDeps` wires the real seams: the composition-root TaskStore,
 * the real daemon-client `sendRequest`, the resolved context, and the
 * `console.log`/`console.error` sinks. The in-process test adapter
 * (`test-adapter.ts`) supplies an in-memory store and a fake daemon instead.
 */

import { resolve } from 'node:path'
import { route, type CommandRegistry } from './registry'
import type { CommandDeps, CommandResult } from './command'
import type { DomainTaskStore } from '../core/store/task-store'
import type { ParsedArgs } from './args'

/**
 * The shape of an "unknown command" so the adapter can print the right
 * top-level-vs-subcommand usage. `null` from {@link route} maps to this.
 */
export interface UnknownCommand {
  unknown: true
  cmd: string | undefined
}

export const dispatch = async (
  registry: CommandRegistry,
  parsed: ParsedArgs,
  deps: CommandDeps,
): Promise<CommandResult | UnknownCommand> => {
  const match = route(registry, parsed.positional)
  if (!match) {
    return { unknown: true, cmd: parsed.positional[0] }
  }
  // Hand the command a ParsedArgs scoped to its own positionals (the path
  // tokens that selected it are stripped). repo/flags/multiFlags pass through.
  const scoped: ParsedArgs = {
    repo: parsed.repo,
    flags: parsed.flags,
    multiFlags: parsed.multiFlags,
    positional: match.rest,
  }
  return match.command.run(scoped, deps)
}

export const isUnknown = (
  r: CommandResult | UnknownCommand,
): r is UnknownCommand => 'unknown' in r

/**
 * Build the production {@link CommandDeps}: real store, real daemon transport,
 * resolved context, console sinks.
 *
 * Both `ctx` and `store` are resolved lazily on first access.
 *
 * `ctx` laziness: `resolveContext` mkdirs the repo's `.mars/`, so commands
 * that never touch `deps.ctx` (notably the `ui` family, which uses the raw
 * `--repo` flag) do not create state directories — matching the pre-seam
 * ordering where `ui` ran before context resolution.
 *
 * `store` laziness: the queue client singleton inside `resolveQueueClient()`
 * resolves its DB target (the `.mars/pg.dsn` DSN, or the state-dir identity
 * key on the PGlite backend) from the context singleton the first time it is
 * called. By deferring store construction until after `deps.ctx` is
 * accessed (which writes the correct --repo path into the context cache),
 * the queue client is guaranteed to connect to the right repo's database —
 * the one under `--repo`, not the one under `CWD`/`MARS_REPO`. Without this
 * ordering, `getDefaultDomainTaskStore()` called eagerly would pick up
 * whatever the CWD resolved to, silently reading the wrong database.
 */
export const makeProductionDeps = async (
  repo: string | undefined,
): Promise<CommandDeps> => {
  // Propagate --repo into MARS_REPO so the store-layer cross-boundary guard
  // recognises this as a deliberate explicit binding and does not refuse to
  // open the database when the process CWD happens to sit inside a worktree
  // of that same repo (the documented live-session workflow: attach → worktree
  // CWD → mars --repo <root> show / task note / task check / step done).
  if (repo) process.env.MARS_REPO = resolve(repo)

  const { resolveContext } = await import('../core/context')
  const { getDefaultDomainTaskStore } = await import('../core/store/task-store')
  const { sendRequest } = await import('../core/daemon/client')

  let resolvedCtx: ReturnType<typeof resolveContext> | undefined
  let resolvedStore: ReturnType<typeof getDefaultDomainTaskStore> | undefined

  const deps = {
    // Wrap sendRequest so every daemon-routed mutation inherits the resolved
    // --repo value. Commands call `deps.daemon.sendRequest(req)` with no opts;
    // the wrapper injects `repo` before forwarding to the real transport, so
    // the daemon socket is resolved under <repo>/.mars/ rather than CWD/MARS_REPO.
    // Per-call opts (autoSpawn, onSpawnNotice, or an explicit repo override)
    // are spread last and therefore take precedence over the default `repo`.
    daemon: {
      sendRequest: (
        req: Parameters<typeof sendRequest>[0],
        opts?: Parameters<typeof sendRequest>[1],
      ) => sendRequest(req, { repo, ...opts }),
    },
    out: (s: string): void => {
      console.log(s)
    },
    err: (s: string): void => {
      console.error(s)
    },
  } as CommandDeps

  Object.defineProperty(deps, 'ctx', {
    enumerable: true,
    get(): ReturnType<typeof resolveContext> {
      if (!resolvedCtx) resolvedCtx = resolveContext(repo)
      return resolvedCtx
    },
  })

  Object.defineProperty(deps, 'store', {
    enumerable: true,
    get(): DomainTaskStore {
      if (!resolvedStore) {
        // Force context resolution first so that the queue client singleton
        // (created inside resolveQueueClient()) picks up the correct DB target
        // from the already-cached context rather than falling back to CWD.
        void deps.ctx
        resolvedStore = getDefaultDomainTaskStore()
      }
      return resolvedStore
    },
  })

  return deps
}
