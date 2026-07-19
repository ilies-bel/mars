/**
 * `tool-forge scan` CLI command.
 *
 * Walks recent failed tasks, runs the missing-helper classifier, and for any
 * helperKey whose occurrence count reaches the threshold (default 3, override
 * via MARS_TOOL_FORGE_THRESHOLD) inserts one 'proposed' ledger row and
 * enqueues exactly one task tagged 'tool-forge'. Re-running is idempotent.
 */

import type { Command } from '../command'

const toolForgeGroup: Command = {
  path: 'tool-forge',
  summary: 'tool-forge subcommands',
  usage: 'usage: mars tool-forge <scan>',
  run: (_args, deps) => {
    deps.err('usage: mars tool-forge <scan>')
    return { code: 1 }
  },
}

const toolForgeScan: Command = {
  path: 'tool-forge scan',
  summary: 'scan failed tasks for recurring missing-helper patterns and enqueue tool-forge tasks',
  usage: 'usage: mars tool-forge scan',
  run: async (_args, deps) => {
    const { scanForRecurringHelperGaps } = await import(
      '../../core/lib/tool-forge-scanner'
    )
    const { enqueueTask } = await import('../../core/queue')
    const { resolveStateClient } = await import('../../core/store/state-client')
    const { initToolPromotionAttempts } = await import(
      '../../core/store/tool-promotion-store'
    )

    await initToolPromotionAttempts()

    const db = resolveStateClient()

    const result = await scanForRecurringHelperGaps(db, {
      enqueue: async (prompt, arcIds) => {
        const task = await enqueueTask(prompt, undefined, {
          workflow: 'tool-forge',
          tags: ['tool-forge'],
          skipTriage: true,
        })
        return task.id
      },
    })

    // ── Summary output ───────────────────────────────────────────────────────
    const keyCount = Object.keys(result.matchesPerKey).length
    if (keyCount === 0) {
      deps.out('no missing-helper patterns detected in recent failed tasks')
      return { code: 0 }
    }

    deps.out(`matches per helperKey (${keyCount} key(s)):`)
    for (const [key, count] of Object.entries(result.matchesPerKey)) {
      const crossed = result.thresholdCrossed.includes(key) ? ' ✓ threshold crossed' : ''
      deps.out(`  ${key}: ${count} match(es)${crossed}`)
    }

    if (result.thresholdCrossed.length === 0) {
      deps.out('\nno keys crossed the threshold — nothing enqueued')
    } else {
      deps.out(`\nthreshold crossed: ${result.thresholdCrossed.join(', ')}`)
      if (result.enqueued.length > 0) {
        deps.out(`tasks enqueued: ${result.enqueued.length}`)
        for (const id of result.enqueued) {
          deps.out(`  ${id}`)
        }
      } else {
        deps.out('tasks enqueued: 0 (ledger rows already exist for these keys)')
      }
    }

    return { code: 0 }
  },
}

export const toolForgeCommands: readonly Command[] = [toolForgeGroup, toolForgeScan]
