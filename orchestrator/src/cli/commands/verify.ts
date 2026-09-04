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
import { resolveContext } from '../../core/context'
import {
  detectMalformedGateArgs,
  PACKAGE_RUNNER_CMDS,
} from '../../core/lib/gate-args-validation'
import { hasFlag, detectNonexistentNpmScript } from '../args'
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
  run: async (args, deps) => {
    // Honour --repo: update the context singleton before listVerifyGates() reads it.
    if (args.repo) resolveContext(args.repo)
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
    'usage: mars verify add <name> --cmd <cmd> --evidence <text> [-- <arg>...] [--args <arg>...] [--scope <scope>] [--tier task|integration] [--optional]',
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

    // Gate args can be supplied via --args (repeatable) or via a bare -- separator
    // (everything after -- becomes the gate's argv). Both forms are supported and
    // combined; -- args come first since that is the shell-natural ordering.
    const gateArgs = [...(args.rest ?? []), ...(args.multiFlags['--args'] ?? [])]

    // Refuse to register a bare-multiplexer gate. A command like `npx` with no
    // args runs a REPL or prints help — it never verifies what the gate name implies.
    if (gateArgs.length === 0 && PACKAGE_RUNNER_CMDS.has(cmd)) {
      deps.err(
        `refusing to register a bare '${cmd}' gate with no arguments — it would ` +
          `${cmd === 'npm' || cmd === 'yarn' ? 'always fail' : 'always pass'} without checking anything. ` +
          `Specify what to run via -- or --args: e.g. --cmd ${cmd} -- <subcommand>`,
      )
      return { code: 2 }
    }

    // Reject any arg element that contains whitespace when the cmd is a package
    // runner. A single "run test:e2e" token becomes npm "run test:e2e" at the
    // shell level — npm treats it as an unknown command and always fails with a
    // generic usage error, never verifying what the gate name implies.
    const malformedMsg = detectMalformedGateArgs(cmd, gateArgs)
    if (malformedMsg) {
      deps.err(malformedMsg)
      return { code: 2 }
    }

    // Reject npm gates that name a script absent from the scope's package.json,
    // or whose body unconditionally passes. Synthesise a verify-cmd string
    // (`cd <scope> && npm <args...>`) and run it through the same validator used
    // by `task add --verify`, so registration-time and enqueue-time share one
    // code path.
    const required = !hasFlag(args, '--optional')
    if (cmd === 'npm' && gateArgs.length > 0 && deps.ctx.repoRoot) {
      const fakeCmd =
        scope === '.'
          ? `npm ${gateArgs.join(' ')}`
          : `cd ${scope} && npm ${gateArgs.join(' ')}`
      const scriptErr = detectNonexistentNpmScript(fakeCmd, deps.ctx.repoRoot)
      if (scriptErr !== null) {
        // Hard error when required=true (the default); warning only when optional.
        if (required) {
          deps.err(scriptErr)
          return { code: 2 }
        }
        deps.err(`[mars] warning: ${scriptErr.replace(/^\[mars\] /, '')}`)
      }
    }

    // --evidence <text>: required (DEC-11). Record what observation justified
    // adding this gate so it is traceable to the real-world signal.
    const evidence = args.flags['--evidence']
    if (!evidence?.trim()) {
      deps.err(
        '--evidence is required: describe the observation that justifies this gate ' +
          '(e.g. "3 tasks failed with the same signature across unrelated branches")',
      )
      return { code: 2 }
    }

    try {
      const id = await addVerifyGate({
        scope,
        name,
        cmd,
        args: gateArgs,
        required,
        tier,
        source: 'operator',
        evidence,
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
      // Delete by id.
      const deleted = await removeVerifyGate(nameOrId)
      if (!deleted) {
        deps.err(`no verify gate with id '${nameOrId}'`)
        return { code: 1 }
      }
      deps.out(`removed verify gate '${nameOrId}'`)
    } else {
      // Delete by name within the given scope.
      const scope = args.flags['--scope'] ?? '.'
      const deleted = await removeVerifyGate({ scope, name: nameOrId })
      if (!deleted) {
        // Check if a gate with this name exists in a different scope.
        const all = await listVerifyGates()
        const inOtherScope = all.find((g) => g.name === nameOrId)
        if (inOtherScope) {
          deps.err(
            `no verify gate named '${nameOrId}' in scope '${scope}' ` +
              `(found in scope '${inOtherScope.scope}' — re-run with --scope ${inOtherScope.scope})`,
          )
        } else {
          deps.err(`no verify gate named '${nameOrId}' in scope '${scope}'`)
        }
        return { code: 1 }
      }
      deps.out(`removed verify gate '${nameOrId}' (scope: ${scope})`)
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
