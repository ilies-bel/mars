/**
 * `verify-gate` command group — operator management of the verify_gates table.
 *
 * Three subcommands:
 *   verify-gate list   — print all registered gates
 *   verify-gate add    — insert a new gate (--scope, --name, --cmd, [-- args...])
 *   verify-gate remove — delete a gate by id or by (--scope, --name) pair
 *
 * All three call the core verify-gates functions directly (no daemon round-trip)
 * because these are direct DB writes that do not require the daemon's serialised
 * task lifecycle.
 */

import {
  addVerifyGate,
  listVerifyGates,
  removeVerifyGate,
} from '../../core/verify-gates'
import type { Command } from '../command'

/** Detect a PostgreSQL UNIQUE-constraint violation (23505) or its message equivalent. */
const isUniqueConstraint = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false
  const e = err as Error & { code?: string }
  if (e.code === '23505') return true
  return /duplicate key value violates unique constraint/i.test(e.message)
}

const verifyGateList: Command = {
  path: 'verify-gate list',
  summary: 'list all registered verify gates',
  usage: 'usage: mars verify-gate list',
  run: async (_args, deps) => {
    const gates = await listVerifyGates()
    if (gates.length === 0) {
      deps.out('(no verify gates configured)')
      return { code: 0 }
    }
    // Header
    deps.out(
      [
        'id'.padEnd(36),
        'scope'.padEnd(20),
        'name'.padEnd(20),
        'cmd'.padEnd(10),
        'args'.padEnd(24),
        'required'.padEnd(8),
        'tier'.padEnd(12),
        'source'.padEnd(10),
        'created_at',
      ].join('  '),
    )
    deps.out(
      [
        '--'.padEnd(36),
        '-----'.padEnd(20),
        '----'.padEnd(20),
        '---'.padEnd(10),
        '----'.padEnd(24),
        '--------'.padEnd(8),
        '----'.padEnd(12),
        '------'.padEnd(10),
        '----------',
      ].join('  '),
    )
    for (const g of gates) {
      deps.out(
        [
          g.id.padEnd(36),
          g.scope.slice(0, 20).padEnd(20),
          g.name.slice(0, 20).padEnd(20),
          g.cmd.slice(0, 10).padEnd(10),
          JSON.stringify(g.args).slice(0, 24).padEnd(24),
          String(g.required).padEnd(8),
          g.tier.padEnd(12),
          g.source.slice(0, 10).padEnd(10),
          g.createdAt,
        ].join('  '),
      )
    }
    return { code: 0 }
  },
}

const verifyGateAdd: Command = {
  path: 'verify-gate add',
  summary: 'register a new verify gate',
  usage:
    'usage: mars verify-gate add --name <n> --cmd <c> [--scope <s>] [-- <args...>] [--tier task|integration] [--required|--optional]',
  run: async (args, deps) => {
    const name = args.flags['--name']
    const cmd = args.flags['--cmd']

    if (!name) {
      deps.err('--name is required')
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

    // Gate args follow the '--' separator in positionals.
    const dashIdx = args.positional.indexOf('--')
    const preDash = dashIdx === -1 ? args.positional : args.positional.slice(0, dashIdx)
    const gateArgs = dashIdx === -1 ? [] : args.positional.slice(dashIdx + 1)

    // --optional anywhere before '--' makes required=false; --required is the default.
    const required = !preDash.includes('--optional')

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

const verifyGateRemove: Command = {
  path: 'verify-gate remove',
  summary: 'delete a verify gate by id or by (--scope, --name) pair',
  usage:
    'usage: mars verify-gate remove <id>  |  mars verify-gate remove --scope <s> --name <n>',
  run: async (args, deps) => {
    const id = args.positional[0]
    const scope = args.flags['--scope']
    const name = args.flags['--name']

    if (id) {
      // Delete by id — idempotent (silent no-op when not found).
      await removeVerifyGate(id)
      return { code: 0 }
    }

    if (scope && name) {
      // Delete by (scope, name) pair — also idempotent.
      await removeVerifyGate({ scope, name })
      return { code: 0 }
    }

    deps.err(
      'usage: mars verify-gate remove <id>  |  mars verify-gate remove --scope <s> --name <n>',
    )
    return { code: 2 }
  },
}

const verifyGateGroup: Command = {
  path: 'verify-gate',
  summary: 'manage verify gate registrations',
  usage: 'usage: mars verify-gate <list|add|remove>',
  run: (_args, deps) => {
    deps.err('usage: mars verify-gate <list|add|remove>')
    return { code: 2 }
  },
}

export const verifyGateCommands: readonly Command[] = [
  verifyGateList,
  verifyGateAdd,
  verifyGateRemove,
  verifyGateGroup,
]
