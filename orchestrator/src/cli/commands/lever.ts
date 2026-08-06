/**
 * `lever` command group: `list` and `show <id>`.
 *
 * `mars lever list` — tabular view of every user-updatable parameter: id,
 *   family, scope, current value (read directly from config files), and the
 *   gesture that applies a change. Entries without a gesture print `(no gesture)`.
 *
 * `mars lever show <id>` — detailed view of one entry including allowed values
 *   and whether a restart is required.
 *
 * Both commands are read-only and require no daemon connection.
 */

import type { Command } from '../command'
import { loadLeverRegistry, noGestureEntries } from '../../core/lib/lever-registry'
import { ok, fail } from '../command'

const leverList: Command = {
  path: 'lever list',
  summary: 'list all user-updatable Mars parameters',
  usage: 'usage: mars lever list',
  helpBody: [
    'Prints every configurable lever with its current value and the command that',
    'changes it. Entries that lack a runtime command print "(no gesture)" — these',
    'are documented gaps that a follow-up slice will address.',
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
  run: (args, deps) => {
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

    const cur = entry.readCurrent() ?? '(requires daemon/db connection)'

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

export const leverCommands: readonly Command[] = [leverList, leverShow]
