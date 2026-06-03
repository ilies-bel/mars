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
 * (`test-adapter.ts`) supplies a `:memory:` store and a fake daemon instead.
 */

import { route, type CommandRegistry } from './registry'
import type { CommandDeps, CommandResult } from './command'
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
 * `ctx` is resolved lazily on first access. `resolveContext` mkdirs the repo's
 * `.mars/`, so commands that never touch `deps.ctx` (notably the `ui` family,
 * which uses the raw `--repo` flag) do not create state directories — matching
 * the pre-seam ordering where `ui` ran before context resolution.
 */
export const makeProductionDeps = async (
  repo: string | undefined,
): Promise<CommandDeps> => {
  const { resolveContext } = await import('../core/context')
  const { getDefaultDomainTaskStore } = await import('../core/store/task-store')
  const { sendRequest } = await import('../core/daemon/client')

  let resolvedCtx: ReturnType<typeof resolveContext> | undefined
  const deps = {
    store: getDefaultDomainTaskStore(),
    daemon: { sendRequest },
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

  return deps
}
