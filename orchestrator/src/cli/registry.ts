/**
 * The flat, path-keyed Command registry and its router (ADR-0023 §1).
 *
 * Every leaf is registered by its full space-joined path ('task add',
 * 'glossary set', 'where'). Grouping ('task', 'proposal', …) is *computed* by
 * `path[0]` for help/discovery — it is not an object and not a registry key.
 *
 * The router (`route`) is a pure prefix match with zero bypass branches: real
 * CLI depth is fixed at 2, so it tries the 2-token path ('task add') first,
 * then the 1-token path ('where'). The matched {@link Command} plus the
 * remaining positionals are returned; dispatch and exit-mapping live in the
 * adapters.
 */

import type { Command } from './command'

/** The flat path-keyed registry. Insertion order is preserved for help. */
export type CommandRegistry = ReadonlyMap<string, Command>

/**
 * Build a registry from a flat list of commands, rejecting duplicate paths.
 */
export const buildRegistry = (commands: readonly Command[]): CommandRegistry => {
  const map = new Map<string, Command>()
  for (const cmd of commands) {
    if (map.has(cmd.path)) {
      throw new Error(`duplicate command path in registry: '${cmd.path}'`)
    }
    map.set(cmd.path, cmd)
  }
  return map
}

export interface RouteMatch {
  command: Command
  /** Positionals after the matched path tokens. */
  rest: string[]
}

/**
 * Resolve the positionals to a {@link Command} via pure prefix matching.
 *
 * Tries the 2-token path first ('task add'), then the 1-token path ('where').
 * Returns `null` when nothing matches — the adapter decides how to report an
 * unknown command (top-level vs subcommand usage).
 */
export const route = (
  registry: CommandRegistry,
  positional: readonly string[],
): RouteMatch | null => {
  const [first, second] = positional
  if (first === undefined) return null

  if (second !== undefined) {
    const twoTokenPath = `${first} ${second}`
    const twoTokenCmd = registry.get(twoTokenPath)
    if (twoTokenCmd) {
      return { command: twoTokenCmd, rest: positional.slice(2) }
    }
  }

  const oneTokenCmd = registry.get(first)
  if (oneTokenCmd) {
    return { command: oneTokenCmd, rest: positional.slice(1) }
  }

  return null
}

/** Group registry paths by their first token for help/discovery. */
export const groupByTopLevel = (
  registry: CommandRegistry,
): Map<string, Command[]> => {
  const groups = new Map<string, Command[]>()
  for (const cmd of registry.values()) {
    const top = cmd.path.split(' ')[0] as string
    const bucket = groups.get(top) ?? []
    bucket.push(cmd)
    groups.set(top, bucket)
  }
  return groups
}
