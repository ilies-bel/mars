/**
 * `classifier` command group: `add`, `remove`, `list`.
 *
 * Manages operator-defined verify-failure classifier patterns persisted in
 * `.mars/daemon.json` under the `customClassifiers` key. Changes are written
 * via the existing atomic `patchDaemonConfigFile` path so no daemon restart
 * is required for consumers that re-read on each invocation.
 */

import type { Command } from '../command'
import {
  readCustomClassifiers,
  patchDaemonConfigFile,
} from '../../core/daemon/config'

const classifierAdd: Command = {
  path: 'classifier add',
  summary: 'register a custom verify-failure classifier pattern',
  usage:
    'usage: mars classifier add <name> (--match <regex> | --match-full <regex>) [--guidance <text>]',
  run: (args, deps) => {
    const name = args.positional[0]
    if (!name) {
      deps.err(
        'usage: mars classifier add <name> (--match <regex> | --match-full <regex>) [--guidance <text>]',
      )
      return { code: 2 }
    }

    const match = args.flags['--match']
    const matchFull = args.flags['--match-full']
    const guidance = args.flags['--guidance']

    if (!match && !matchFull) {
      deps.err('error: at least one of --match or --match-full is required')
      return { code: 2 }
    }

    // Validate each regex by construction
    if (match !== undefined) {
      try {
        new RegExp(match)
      } catch (e) {
        deps.err(`error: --match is not a valid regex: ${(e as Error).message}`)
        return { code: 2 }
      }
    }
    if (matchFull !== undefined) {
      try {
        new RegExp(matchFull)
      } catch (e) {
        deps.err(
          `error: --match-full is not a valid regex: ${(e as Error).message}`,
        )
        return { code: 2 }
      }
    }

    const existing = readCustomClassifiers()
    if (existing.some((c) => c.name === name)) {
      deps.err(
        `error: a classifier named "${name}" already exists; remove it first`,
      )
      return { code: 1 }
    }

    const entry: Record<string, string> = { name }
    if (match !== undefined) entry['match'] = match
    if (matchFull !== undefined) entry['matchFull'] = matchFull
    if (guidance !== undefined) entry['guidance'] = guidance

    patchDaemonConfigFile({
      customClassifiers: [...existing, entry],
    })

    deps.out(`classifier added: "${name}"`)
    return { code: 0 }
  },
}

const classifierRemove: Command = {
  path: 'classifier remove',
  summary: 'remove a custom verify-failure classifier pattern by name',
  usage: 'usage: mars classifier remove <name>',
  run: (args, deps) => {
    const name = args.positional[0]
    if (!name) {
      deps.err('usage: mars classifier remove <name>')
      return { code: 2 }
    }

    const existing = readCustomClassifiers()
    const index = existing.findIndex((c) => c.name === name)
    if (index === -1) {
      deps.err(`error: no classifier named "${name}" found`)
      return { code: 1 }
    }

    const updated = existing.filter((c) => c.name !== name)
    patchDaemonConfigFile({ customClassifiers: updated })

    deps.out(`classifier removed: "${name}"`)
    return { code: 0 }
  },
}

const classifierList: Command = {
  path: 'classifier list',
  summary: 'list registered custom verify-failure classifier patterns',
  usage: 'usage: mars classifier list',
  run: (_args, deps) => {
    const classifiers = readCustomClassifiers()
    for (const c of classifiers) {
      deps.out(
        `${c.name}\t${c.match ?? ''}\t${c.matchFull ?? ''}\t${c.guidance ?? ''}`,
      )
    }
    return { code: 0 }
  },
}

const classifierGroup: Command = {
  path: 'classifier',
  summary: 'classifier subcommands',
  usage: 'usage: mars classifier <add|remove|list> ...',
  run: (_args, deps) => {
    deps.err('usage: mars classifier <add|remove|list> ...')
    return { code: 2 }
  },
}

export const classifierCommands: readonly Command[] = [
  classifierAdd,
  classifierRemove,
  classifierList,
  classifierGroup,
]
