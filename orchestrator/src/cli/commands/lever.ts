/**
 * `lever` command group: `list`, `show <id>`, and `set <id> <value>`.
 *
 * `mars lever list` — tabular view of every user-updatable parameter: id,
 *   family, scope, current value (read directly from config files), and the
 *   gesture that applies a change.
 *
 * `mars lever show <id>` — detailed view of one entry including allowed values
 *   and whether a restart is required.
 *
 * `mars lever set <id> <value>` — validate <value> against the registry's
 *   allowedValues, persist to daemon.json, echo the transition, and report
 *   whether a daemon restart is required. Only the configurable global levers
 *   backed by daemon.json sections (provider.default, scoring.*, self-evolve.*)
 *   are settable via this command. Levers with dedicated commands (caps.*,
 *   operator.*, budget.*) are redirected to their own gestures.
 *
 * All three commands are read-only with respect to the daemon socket (no RPC
 * call required).
 */

import type { Command } from '../command'
import { loadLeverRegistry, noGestureEntries } from '../../core/lib/lever-registry'
import type { CapQuerier } from '../../core/lib/lever-registry'
import { readDaemonConfigFile, patchDaemonConfigFile } from '../../core/daemon/config'
import { ok, fail } from '../command'

const leverList: Command = {
  path: 'lever list',
  summary: 'list all user-updatable Mars parameters',
  usage: 'usage: mars lever list',
  helpBody: [
    'Prints every configurable lever with its current value and the command that',
    'changes it.',
    '',
    'No daemon connection required; values are read directly from config files.',
  ].join('\n'),
  run: (_args, deps) => {
    const entries = loadLeverRegistry()

    // Column widths — computed from data for readability
    const idW = Math.max(4, ...entries.map((e) => e.id.length))
    const famW = Math.max(6, ...entries.map((e) => e.family.length))
    const scopeW = Math.max(5, ...entries.map((e) => e.scope.length))
    const curW = Math.max(7, ...entries.map((e) => (e.readCurrent() ?? '(unknown)').length))

    const pad = (s: string, w: number) => s.padEnd(w)

    deps.out(
      `${pad('id', idW)}  ${pad('family', famW)}  ${pad('scope', scopeW)}  ${pad('current', curW)}  gesture`,
    )
    deps.out(
      `${'-'.repeat(idW)}  ${'-'.repeat(famW)}  ${'-'.repeat(scopeW)}  ${'-'.repeat(curW)}  ${'-------'}`,
    )

    for (const e of entries) {
      const cur = e.readCurrent() ?? '(unknown)'
      const gesture = e.gesture ?? '(no gesture)'
      deps.out(`${pad(e.id, idW)}  ${pad(e.family, famW)}  ${pad(e.scope, scopeW)}  ${pad(cur, curW)}  ${gesture}`)
    }

    const gaps = noGestureEntries()
    if (gaps.length > 0) {
      deps.out('')
      deps.out(
        `${gaps.length} entr${gaps.length === 1 ? 'y' : 'ies'} lack a runtime gesture — run \`mars lever show <id>\` for details.`,
      )
    }

    return ok()
  },
}

const leverShow: Command = {
  path: 'lever show',
  summary: 'show details for one lever',
  usage: 'usage: mars lever show <id>',
  run: async (args, deps) => {
    const id = args.positional[0]
    if (!id) {
      deps.err('usage: mars lever show <id>')
      return fail(2)
    }

    const entry = loadLeverRegistry().find((e) => e.id === id)
    if (!entry) {
      deps.err(
        `mars lever show: unknown lever '${id}'\nRun \`mars lever list\` to see all lever ids.`,
      )
      return fail(1)
    }

    // Resolve the current value, overlaying daemon-reported effective state
    // when the entry supports it (e.g. caps.implement which the steward
    // autotuner may raise in-process without writing daemon.json).
    let cur: string
    if (entry.readEffective) {
      const configured = entry.readCurrent() ?? '(unknown)'
      const effectiveRead = await entry.readEffective(deps.daemon as CapQuerier)
      if (effectiveRead === null) {
        // Daemon is unreachable — mark as persisted-only to prevent the
        // operator from treating the configured value as the live state.
        cur = `${configured} (persisted only — daemon not running)`
      } else if (effectiveRead.effective === configured) {
        // Configured and effective agree — just show the value.
        cur = effectiveRead.effective
      } else {
        // Drift: the daemon is enforcing a different value than daemon.json.
        // Show both so the operator gets an accurate picture.
        const reasonPart = effectiveRead.reason !== null ? ` — ${effectiveRead.reason}` : ''
        cur = `${configured} (effective ${effectiveRead.effective}${reasonPart}) ⚠`
      }
    } else {
      cur = entry.readCurrent() ?? '(requires daemon/db connection)'
    }

    // Render allowed values
    let allowed: string
    if (entry.allowedValues.type === 'enum') {
      allowed = entry.allowedValues.values.join(' | ')
    } else if (entry.allowedValues.type === 'range') {
      const { min, max } = entry.allowedValues
      allowed = max !== undefined ? `${min}–${max}` : `>= ${min}`
    } else {
      allowed = 'freeform'
    }

    deps.out(`id:          ${entry.id}`)
    deps.out(`label:       ${entry.label}`)
    deps.out(`family:      ${entry.family}`)
    deps.out(`scope:       ${entry.scope}`)
    deps.out(`current:     ${cur}`)
    deps.out(`gesture:     ${entry.gesture ?? '(no gesture — gap for follow-up slice)'}`)
    deps.out(`restart?:    ${entry.appliesWithoutRestart ? 'no' : 'yes (mars daemon reload or restart)'}`)
    deps.out(`allowed:     ${allowed}`)

    if (entry.recipe) {
      const r = entry.recipe
      deps.out('')
      deps.out(`Trigger:     ${r.triggerPattern}`)
      deps.out(`Problem:     ${r.problem}`)
      deps.out(`Solution:    ${r.solution}`)
      deps.out(`Maturity:    ${r.maturityLevel}`)
      if (r.setupSteps.length > 0) {
        deps.out('')
        deps.out('Setup steps:')
        for (const step of r.setupSteps) {
          deps.out(`  - ${step}`)
        }
      }
      if (r.verifyGate) {
        const { name, cmd, args: vArgs, scope } = r.verifyGate
        const cmdStr = [cmd, ...vArgs].join(' ')
        const scopePart = scope ? ` (scope: ${scope})` : ''
        deps.out('')
        deps.out(`Verify gate: ${name} → ${cmdStr}${scopePart}`)
      }
    }

    return ok()
  },
}

/**
 * The lever IDs settable via `mars lever set`. These are the configurable global
 * levers backed by daemon.json sections that have no dedicated command. Levers
 * with dedicated commands (caps.* → `daemon set-cap`, operator.* → `operator
 * set`, budget.* → `operator set budget-*`) are NOT listed here — callers
 * are redirected to those commands.
 */
const SETTABLE_LEVER_IDS = new Set([
  'provider.default',
  'scoring.auto-trigger',
  'scoring.low-trend-threshold',
  'scoring.low-trend-window',
  'self-evolve.auto-enqueue',
  'self-evolve.drift-threshold-pct',
  'self-evolve.task-confidence-threshold',
])

const leverSet: Command = {
  path: 'lever set',
  summary: 'set a configurable lever by registry id and persist to daemon.json',
  usage: 'usage: mars lever set <id> <value>',
  helpBody: [
    'Validates <value> against the registry allowedValues, persists to daemon.json,',
    'echoes the old → new transition, and reports whether a daemon restart is needed.',
    '',
    'Settable via this command:',
    '  provider.default                   claude | codex | gemini',
    '  scoring.auto-trigger               true | false',
    '  scoring.low-trend-threshold        0–1',
    '  scoring.low-trend-window           >= 1 (positive integer)',
    '  self-evolve.auto-enqueue           true | false',
    '  self-evolve.drift-threshold-pct    >= 0',
    '  self-evolve.task-confidence-threshold  0–1',
    '',
    'Other levers use dedicated commands — see mars lever list.',
  ].join('\n'),
  run: (args, deps) => {
    const positional = args.positional.filter((a) => !a.startsWith('--'))
    const id = positional[0]
    const value = positional[1]

    if (!id || value === undefined) {
      deps.err('usage: mars lever set <id> <value>')
      return fail(2)
    }

    const entry = loadLeverRegistry().find((e) => e.id === id)
    if (!entry) {
      deps.err(
        `mars lever set: unknown lever '${id}'\nRun 'mars lever list' to see all lever ids.`,
      )
      return fail(1)
    }

    if (!SETTABLE_LEVER_IDS.has(id)) {
      const redirect = entry.gesture
        ? `use: ${entry.gesture}`
        : '(no command available for this lever)'
      deps.err(`mars lever set: lever '${id}' is not settable via this command; ${redirect}`)
      return fail(2)
    }

    // ── Validate against the registry's allowedValues ────────────────────────
    const { allowedValues } = entry
    if (allowedValues.type === 'enum') {
      if (!allowedValues.values.includes(value)) {
        deps.err(
          `mars lever set: invalid value '${value}' for '${id}'; allowed: ${allowedValues.values.join(' | ')}`,
        )
        return fail(2)
      }
    } else if (allowedValues.type === 'range') {
      const parsed = Number(value)
      // scoring.low-trend-window is a count of instances: must be a positive integer.
      const requiresInteger = id === 'scoring.low-trend-window'
      if (!Number.isFinite(parsed)) {
        deps.err(`mars lever set: '${id}' requires a number; got '${value}'`)
        return fail(2)
      }
      if (requiresInteger && !Number.isInteger(parsed)) {
        deps.err(
          `mars lever set: '${id}' requires a positive integer; got '${value}'`,
        )
        return fail(2)
      }
      if (parsed < allowedValues.min) {
        const bound =
          allowedValues.max !== undefined
            ? `${allowedValues.min}–${allowedValues.max}`
            : `>= ${allowedValues.min}`
        deps.err(`mars lever set: '${id}' must be ${bound}; got '${value}'`)
        return fail(2)
      }
      if (allowedValues.max !== undefined && parsed > allowedValues.max) {
        deps.err(
          `mars lever set: '${id}' must be ${allowedValues.min}–${allowedValues.max}; got '${value}'`,
        )
        return fail(2)
      }
    }
    // freeform: no validation

    // ── Read old value for transition echo (before writing) ──────────────────
    const oldValue = entry.readCurrent() ?? '(unknown)'

    // ── Persist to daemon.json ───────────────────────────────────────────────
    const file = readDaemonConfigFile()

    if (id === 'provider.default') {
      patchDaemonConfigFile({ defaultProvider: value })
    } else if (id.startsWith('scoring.')) {
      const existing =
        file.scoring !== null && typeof file.scoring === 'object' && !Array.isArray(file.scoring)
          ? (file.scoring as Record<string, unknown>)
          : {}
      const field =
        id === 'scoring.auto-trigger'
          ? 'autoTrigger'
          : id === 'scoring.low-trend-threshold'
            ? 'lowTrendThreshold'
            : 'lowTrendWindow'
      const typed =
        id === 'scoring.auto-trigger' ? value === 'true' : Number(value)
      patchDaemonConfigFile({ scoring: { ...existing, [field]: typed } })
    } else if (id.startsWith('self-evolve.')) {
      const existing =
        file.selfEvolve !== null &&
        typeof file.selfEvolve === 'object' &&
        !Array.isArray(file.selfEvolve)
          ? (file.selfEvolve as Record<string, unknown>)
          : {}
      const field =
        id === 'self-evolve.auto-enqueue'
          ? 'autoEnqueue'
          : id === 'self-evolve.drift-threshold-pct'
            ? 'driftThresholdPct'
            : 'taskConfidenceThreshold'
      const typed =
        id === 'self-evolve.auto-enqueue' ? value === 'true' : Number(value)
      patchDaemonConfigFile({ selfEvolve: { ...existing, [field]: typed } })
    }

    // ── Echo the transition ──────────────────────────────────────────────────
    // Re-read the persisted value so the echo reflects what was actually written.
    const newValue = entry.readCurrent() ?? value
    deps.out(`${id}: ${oldValue} → ${newValue}`)

    if (!entry.appliesWithoutRestart) {
      deps.out('(requires daemon restart to take effect — run: mars daemon restart)')
    }

    return ok()
  },
}

const leverGroup: Command = {
  path: 'lever',
  summary: 'lever subcommands',
  usage: 'usage: mars lever <list|show|set>',
  run: (_args, deps) => {
    deps.err('usage: mars lever <list|show|set>')
    return fail(2)
  },
}

export const leverCommands: readonly Command[] = [leverList, leverShow, leverSet, leverGroup]
