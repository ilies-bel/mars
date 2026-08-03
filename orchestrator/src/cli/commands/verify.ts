/**
 * `verify` command group — simplified interface for managing verify gates.
 *
 * Three subcommands:
 *   verify list   — print all registered gates (compact table)
 *   verify add    — insert a new gate (<name> positional, --cmd required)
 *   verify remove — delete a gate by id or by name within the default scope
 *
 * All three call the core verify-gates functions directly (no daemon round-trip).
 */

import {
  addVerifyGate,
  listVerifyGates,
  removeVerifyGate,
} from '../../core/verify-gates'
import { hasFlag } from '../args'
import type { Command } from '../command'

/** UUID v4 pattern used to distinguish gate ids from gate names. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Detect a PostgreSQL UNIQUE-constraint violation (23505) or its message equivalent. */
const isUniqueConstraint = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false
  const e = err as Error & { code?: string }
  if (e.code === '23505') return true
  return /duplicate key value violates unique constraint/i.test(e.message)
}

const verifyList: Command = {
  path: 'verify list',
  summary: 'list all registered verify gates',
  usage: 'usage: mars verify list',
  run: async (_args, deps) => {
    const gates = await listVerifyGates()
    if (gates.length === 0) {
      deps.out('(no verify gates configured)')
      return { code: 0 }
    }
    deps.out(
      [
        'scope'.padEnd(20),
        'name'.padEnd(20),
        'cmd'.padEnd(10),
        'args'.padEnd(24),
        'tier'.padEnd(12),
        'required'.padEnd(8),
        'source',
      ].join('  '),
    )
    deps.out(
      [
        '-----'.padEnd(20),
        '----'.padEnd(20),
        '---'.padEnd(10),
        '----'.padEnd(24),
        '----'.padEnd(12),
        '--------'.padEnd(8),
        '------',
      ].join('  '),
    )
    for (const g of gates) {
      deps.out(
        [
          g.scope.slice(0, 20).padEnd(20),
          g.name.slice(0, 20).padEnd(20),
          g.cmd.slice(0, 10).padEnd(10),
          JSON.stringify(g.args).slice(0, 24).padEnd(24),
          g.tier.padEnd(12),
          String(g.required).padEnd(8),
          g.source,
        ].join('  '),
      )
    }
    return { code: 0 }
  },
}

const verifyAdd: Command = {
  path: 'verify add',
  summary: 'register a new verify gate',
  usage:
    'usage: mars verify add <name> --cmd <cmd> [--args <arg>...] [--scope <scope>] [--tier task|integration] [--optional]',
  run: async (args, deps) => {
    const name = args.positional[0]
    const cmd = args.flags['--cmd']

    if (!name) {
      deps.err('name is required')
      return { code: 2 }
    }
    if (!cmd) {
      deps.err('--cmd is required')
      return { code: 2 }
    }

    const scope = args.flags['--scope'] ?? '.'

    const tierRaw = args.flags['--tier'] ?? 'task'
    if (tierRaw !== 'task' && tierRaw !== 'integration') {
      deps.err('--tier must be one of: task, integration')
      return { code: 2 }
    }
    const tier = tierRaw as 'task' | 'integration'

    const gateArgs = args.multiFlags['--args'] ?? []
    const required = !hasFlag(args, '--optional')

    try {
      const id = await addVerifyGate({
        scope,
        name,
        cmd,
        args: gateArgs,
        required,
        tier,
        source: 'operator',
      })
      deps.out(id)
      return { code: 0 }
    } catch (err: unknown) {
      if (isUniqueConstraint(err)) {
        deps.err(`verify gate (${scope},${name}) already exists`)
        return { code: 1 }
      }
      throw err
    }
  },
}

const verifyRemove: Command = {
  path: 'verify remove',
  summary: 'delete a verify gate by id or by name (within the default scope)',
  usage: 'usage: mars verify remove <name-or-id>',
  run: async (args, deps) => {
    const nameOrId = args.positional[0]

    if (!nameOrId) {
      deps.err('usage: mars verify remove <name-or-id>')
      return { code: 2 }
    }

    if (UUID_RE.test(nameOrId)) {
      // Delete by id — idempotent.
      await removeVerifyGate(nameOrId)
    } else {
      // Delete by name within the default scope.
      const scope = args.flags['--scope'] ?? '.'
      await removeVerifyGate({ scope, name: nameOrId })
    }

    return { code: 0 }
  },
}

const verifyGroup: Command = {
  path: 'verify',
  summary: 'manage verify gate registrations',
  usage: 'usage: mars verify <list|add|remove>',
  run: (_args, deps) => {
    deps.err('usage: mars verify <list|add|remove>')
    return { code: 2 }
  },
}

export const verifyCommands: readonly Command[] = [
  verifyList,
  verifyAdd,
  verifyRemove,
  verifyGroup,
]
