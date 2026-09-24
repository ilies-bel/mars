/**
 * `verify-gate` command group — operator management of the verify_gates table.
 *
 * Subcommands:
 *   verify-gate list    — print all registered gates
 *   verify-gate add     — insert a new gate (--scope, --name, --cmd, [-- args...])
 *   verify-gate remove  — delete a gate by id or by (--scope, --name) pair
 *   verify-gate set     — update an existing gate (e.g. --timeout)
 *   verify-gate restore — clear quarantine on a gate after re-verifying it passes
 *   verify-gate check   — detect drift between supervisor manifest and verify_gates table
 *   verify-gate detect  — propose gates from repository tooling without writing the table
 *
 * All registry commands call the core verify-gates functions directly (no daemon round-trip)
 * because these are direct DB writes/reads that do not require the daemon's
 * serialised task lifecycle.
 */

import path from 'node:path'
import {
  addVerifyGate,
  deriveSignalFreeGates,
  getVerifyGate,
  listVerifyGates,
  removeVerifyGate,
  restoreVerifyGate,
  updateVerifyGate,
} from '../../core/verify-gates'
import { loadVerifyScopes } from '../../core/ports/verifier/verify-helpers'
import { resolveVerifier } from '../../core/ports/verifier/registry'
import { computeFailureSignature } from '../../core/lib/failure-signature'
import { detectVerifyGates } from '../../init/detect-verify-gates'
import { detectMalformedGateArgs } from '../../core/lib/gate-args-validation'
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
    // A quarantined *required* gate is a disabled safety check, not a
    // routine timestamp — surface it as an alarm above the table so it
    // cannot be scrolled past unnoticed. Quarantined-but-optional gates
    // don't gate anything so they don't warrant the banner.
    const brokenRequired = gates.filter((g) => g.state === 'quarantined' && g.required)
    if (brokenRequired.length > 0) {
      deps.out(
        `!! ${brokenRequired.length} required verify gate(s) are QUARANTINED and NOT enforcing !!`,
      )
      for (const g of brokenRequired) {
        deps.out(`     ${g.id}  ${g.scope}/${g.name}  (${g.quarantineSignature ?? 'unknown reason'})`)
      }
      deps.out('     restore with: mars verify-gate restore <id>')
      deps.out('')
    }
    const signalFree = deriveSignalFreeGates(gates)
    if (signalFree.length > 0) {
      deps.out(`!! ${signalFree.length} verify gate condition(s) carry NO SIGNAL !!`)
      for (const f of signalFree) {
        deps.out(`     ${f.gateId}  ${f.scope}/${f.name}  [${f.kind}] ${f.reason}`)
      }
      deps.out('')
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
        'created_at'.padEnd(13),
        'state'.padEnd(12),
        'quarantined_at'.padEnd(16),
        'last_failure'.padEnd(28),
        'last_origin'.padEnd(20),
        'last_failure_at'.padEnd(16),
        'timeout_min',
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
        '----------'.padEnd(13),
        '-----'.padEnd(12),
        '--------------'.padEnd(16),
        '------------'.padEnd(28),
        '-----------'.padEnd(20),
        '---------------'.padEnd(16),
        '-----------',
      ].join('  '),
    )
    for (const g of gates) {
      // A quarantined required gate reads as an alarm, not a status word —
      // an optional gate quarantining is comparatively low-stakes.
      const stateLabel = g.state === 'quarantined' && g.required ? 'QUARANTINED!!' : g.state
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
          String(g.createdAt).padEnd(13),
          stateLabel.padEnd(12),
          (g.quarantinedAt === null ? '—' : String(g.quarantinedAt)).padEnd(16),
          (g.lastFailureSignature ?? 'healthy').slice(0, 28).padEnd(28),
          (g.lastFailureOriginId ?? '—').slice(0, 20).padEnd(20),
          (g.lastFailureAt === null ? '—' : String(g.lastFailureAt)).padEnd(16),
          g.timeoutMin === null ? '—(default)' : String(g.timeoutMin),
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
    'usage: mars verify-gate add --name <n> --cmd <c> --evidence <text> [--scope <s>] [--timeout <min>] [-- <args...>] [--tier task|integration] [--required|--optional]',
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

    // Gate args are the tokens that appeared after the bare '--' separator.
    // parseArgs puts them in args.rest (never in args.positional).
    const gateArgs = args.rest

    // Reject any arg element that contains whitespace when the cmd is a package
    // runner. A single "run test:e2e" token becomes npm "run test:e2e" at the
    // shell level — npm treats it as an unknown command and always fails with a
    // generic usage error, never verifying what the gate name implies.
    const malformedMsg = detectMalformedGateArgs(cmd, gateArgs)
    if (malformedMsg) {
      deps.err(malformedMsg)
      return { code: 2 }
    }

    // --optional makes required=false; --required is the default.
    const required = args.flags['--optional'] === undefined

    // --timeout <minutes>: per-gate wall-clock timeout. Defaults to 20 when omitted.
    let timeoutMin: number | undefined
    const timeoutRaw = args.flags['--timeout']
    if (timeoutRaw !== undefined) {
      const parsed = Number(timeoutRaw)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        deps.err('--timeout must be a positive number (minutes)')
        return { code: 2 }
      }
      timeoutMin = parsed
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
        ...(timeoutMin !== undefined ? { timeoutMin } : {}),
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

const verifyGateCheck: Command = {
  path: 'verify-gate check',
  summary: 'detect drift between supervisor manifest and verify_gates table',
  usage: 'usage: mars verify-gate check [--manifest <path>]',
  run: async (args, deps) => {
    const manifestPath =
      args.flags['--manifest'] ?? path.join(deps.ctx.repoRoot, 'supervisors.json')

    const [scopes, live] = await Promise.all([loadVerifyScopes(manifestPath), listVerifyGates()])

    // Build a set of all (scope, name) pairs declared in the manifest.
    const declared = new Set<string>()
    for (const { scope, steps } of scopes) {
      for (const step of steps) {
        declared.add(`${scope}\x00${step.name}`)
      }
    }

    // Build a set of (scope, name) pairs present in the live table.
    const liveKeys = new Set(live.map((g) => `${g.scope}\x00${g.name}`))

    // missing = declared \ live
    const missing = [...declared].filter((k) => !liveKeys.has(k))

    // orphan = live rows with source='manifest' that are absent from declared
    const orphan = live
      .filter((g) => g.source === 'manifest' && !declared.has(`${g.scope}\x00${g.name}`))
      .map((g) => `${g.scope}\x00${g.name}`)

    if (missing.length === 0 && orphan.length === 0) {
      deps.out('verify-gates in sync with supervisor manifest')
      return { code: 0 }
    }

    if (missing.length > 0) {
      deps.out('missing from verify_gates:')
      for (const k of missing) {
        const sep = k.indexOf('\x00')
        deps.out(`  ${k.slice(0, sep)}/${k.slice(sep + 1)}`)
      }
    }

    if (orphan.length > 0) {
      deps.out('orphaned in verify_gates (source=manifest):')
      for (const k of orphan) {
        const sep = k.indexOf('\x00')
        deps.out(`  ${k.slice(0, sep)}/${k.slice(sep + 1)}`)
      }
    }

    return { code: 1 }
  },
}

const verifyGateDetect: Command = {
  path: 'verify-gate detect',
  summary: 'propose verify gates from repository tooling without registering them',
  usage: 'usage: mars verify-gate detect [--json]',
  run: (args, deps) => {
    const gates = detectVerifyGates(deps.ctx.repoRoot)
    if (args.flags['--json'] !== undefined) {
      deps.out(JSON.stringify(gates))
      return { code: 0 }
    }
    if (gates.length === 0) {
      deps.out('no verify gates detected')
      return { code: 0 }
    }
    for (const gate of gates) {
      deps.out(
        `${gate.scope}  ${gate.name}  ${[gate.cmd, ...gate.args].join(' ')}  ${gate.tier}  ${gate.evidence}`,
      )
    }
    return { code: 0 }
  },
}

const verifyGateSet: Command = {
  path: 'verify-gate set',
  summary: 'update an existing verify gate (e.g. set --timeout, --required, --optional)',
  usage:
    'usage: mars verify-gate set <id>  [--timeout <min>] [--required|--optional]\n' +
    '       mars verify-gate set --scope <s> --name <n>  [--timeout <min>] [--required|--optional]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const scope = args.flags['--scope']
    const name = args.flags['--name']

    // Resolve which gate to target.
    let target: string | { scope: string; name: string }
    if (id) {
      target = id
    } else if (scope && name) {
      target = { scope, name }
    } else {
      deps.err(
        'usage: mars verify-gate set <id> [--timeout <min>] [--required|--optional]\n' +
          '       mars verify-gate set --scope <s> --name <n> [--timeout <min>] [--required|--optional]',
      )
      return { code: 2 }
    }

    // Parse --timeout.
    const timeoutRaw = args.flags['--timeout']
    let timeoutMin: number | null | undefined
    if (timeoutRaw !== undefined) {
      const parsed = Number(timeoutRaw)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        deps.err('--timeout must be a positive number (minutes)')
        return { code: 2 }
      }
      timeoutMin = parsed
    }

    // Parse --required / --optional.
    const hasRequired = '--required' in args.flags
    const hasOptional = '--optional' in args.flags
    if (hasRequired && hasOptional) {
      deps.err('--required and --optional are mutually exclusive')
      return { code: 2 }
    }
    let required: boolean | undefined
    if (hasRequired) required = true
    if (hasOptional) required = false

    if (timeoutMin === undefined && required === undefined) {
      deps.err('at least one flag must be specified; supported: --timeout <min>, --required, --optional')
      return { code: 2 }
    }

    const updates: Parameters<typeof updateVerifyGate>[1] = {}
    if (timeoutMin !== undefined) updates.timeoutMin = timeoutMin
    if (required !== undefined) updates.required = required

    const updated = await updateVerifyGate(target, updates)
    if (!updated) {
      deps.err(
        typeof target === 'string'
          ? `no verify gate with id ${target}`
          : `no verify gate (${target.scope},${target.name})`,
      )
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const verifyGateRestore: Command = {
  path: 'verify-gate restore',
  summary: 're-verify a quarantined gate and, if it passes, clear its quarantine',
  usage:
    'usage: mars verify-gate restore <id> [--force]\n' +
    '       mars verify-gate restore --scope <s> --name <n> [--force]',
  run: async (args, deps) => {
    const id = args.positional[0]
    const scope = args.flags['--scope']
    const name = args.flags['--name']
    const force = args.flags['--force'] !== undefined

    let target: string | { scope: string; name: string }
    if (id) {
      target = id
    } else if (scope && name) {
      target = { scope, name }
    } else {
      deps.err(
        'usage: mars verify-gate restore <id> [--force]\n' +
          '       mars verify-gate restore --scope <s> --name <n> [--force]',
      )
      return { code: 2 }
    }

    const gate = await getVerifyGate(target)
    if (!gate) {
      deps.err(
        typeof target === 'string'
          ? `no verify gate with id ${target}`
          : `no verify gate (${target.scope},${target.name})`,
      )
      return { code: 1 }
    }

    if (gate.state !== 'quarantined') {
      deps.err(`verify gate ${gate.id} (${gate.scope}/${gate.name}) is not quarantined`)
      return { code: 1 }
    }

    if (!force) {
      // Re-run the gate's own command exactly as the real verify phase
      // would, but as a single ad-hoc step: no branch/integrationBranch is
      // passed, so the has-diff/worktree-hygiene gates are skipped and only
      // this one command runs. `tier` is forced to 'task' regardless of the
      // gate's own declared tier — an 'integration' tier would make
      // verifyChanges defer (and NOT run) the step, which would make
      // restore "pass" without actually checking anything.
      // The re-verify can THROW rather than return a failed step — most
      // commonly when the gate's scope directory no longer exists in this
      // repo, which makes run-tool reject the spawn outright ("working
      // directory no longer exists: <path>"). A gate pointing at a vanished
      // directory is exactly the kind of gate an operator reaches for
      // `restore` on, so it must read as "still failing", not as an uncaught
      // crash out of the CLI.
      let output: string
      let passed: boolean
      try {
        const result = await resolveVerifier().run({
          cwd: deps.ctx.repoRoot,
          steps: [
            {
              name: gate.name,
              gateId: gate.id,
              cmd: gate.cmd,
              args: gate.args,
              required: true,
              dir: gate.scope,
              tier: 'task',
              ...(gate.timeoutMin !== null ? { timeoutMin: gate.timeoutMin } : {}),
            },
          ],
        })
        const step = result.steps.find((s) => s.gateId === gate.id) ?? result.steps[0]
        passed = result.passed && (step?.passed ?? false)
        output = step?.output ?? '(no output captured)'
      } catch (error: unknown) {
        passed = false
        output = error instanceof Error ? error.message : String(error)
      }
      if (!passed) {
        const signature = computeFailureSignature(`verify:${gate.name}`, output)
        deps.err(
          `verify gate ${gate.id} (${gate.scope}/${gate.name}) is still failing: ${signature}`,
        )
        deps.err(output)
        deps.err('re-run with --force to restore anyway')
        return { code: 1 }
      }
    }

    const restored = await restoreVerifyGate(target)
    if (!restored) {
      // Lost a race with another restore/quarantine between the lookup
      // above and this write — report it rather than claiming success.
      deps.err(
        `verify gate ${gate.id} (${gate.scope}/${gate.name}) was not restored (state changed concurrently)`,
      )
      return { code: 1 }
    }

    deps.out(`verify gate ${gate.id} (${gate.scope}/${gate.name}) restored — enforcing again`)
    return { code: 0 }
  },
}

const verifyGateGroup: Command = {
  path: 'verify-gate',
  summary: 'manage verify gate registrations',
  usage: 'usage: mars verify-gate <list|add|remove|set|restore|check|detect>',
  run: (_args, deps) => {
    deps.err('usage: mars verify-gate <list|add|remove|set|restore|check|detect>')
    return { code: 2 }
  },
}

export const verifyGateCommands: readonly Command[] = [
  verifyGateList,
  verifyGateAdd,
  verifyGateRemove,
  verifyGateSet,
  verifyGateRestore,
  verifyGateCheck,
  verifyGateDetect,
  verifyGateGroup,
]
