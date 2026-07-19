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
  usage: 'usage: mars tool-forge <scan|bench>',
  run: (_args, deps) => {
    deps.err('usage: mars tool-forge <scan|bench>')
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

const toolForgeBench: Command = {
  path: 'tool-forge bench',
  summary: 'replay motivating arcs and record before/after benchmark metrics',
  usage: 'usage: mars tool-forge bench <attempt-id>',
  run: async (args, deps) => {
    const attemptId = args.positional[0]
    if (!attemptId) {
      deps.err('usage: mars tool-forge bench <attempt-id>')
      return { code: 1 }
    }

    const { runBenchmark } = await import('../../core/lib/tool-benchmark')
    const { resolveStateClient } = await import('../../core/store/state-client')
    const { initToolPromotionAttempts, getAttempt } = await import(
      '../../core/store/tool-promotion-store'
    )

    await initToolPromotionAttempts()
    const db = resolveStateClient()

    const attempt = await getAttempt(db, attemptId)
    if (!attempt) {
      deps.err(`error: attempt not found: ${attemptId}`)
      return { code: 1 }
    }

    deps.out(`benchmarking attempt ${attemptId} (${attempt.motivatingArcIds.length} arc(s))…`)

    // Default arc replayer: placeholder implementation.
    // Real arc replay (baseline = helper absent, treatment = helper present) requires
    // task-execution infrastructure outside the scope of this tracer bullet.
    const result = await runBenchmark(db, attemptId, {
      arcReplayer: async (_arcId, _mode) => ({
        tokensIn: 0,
        tokensOut: 0,
        wallMs: 0,
        exitOk: true,
      }),
    })

    // ── Compact table output ────────────────────────────────────────────────
    type ArcRow = { arcId: string; tokensIn: number; tokensOut: number; wallMs: number; exitOk: boolean }
    const beforeArcs = JSON.parse(result.before) as ArcRow[]
    const afterArcs = JSON.parse(result.after) as ArcRow[]

    const arcWidth = Math.max(
      6,
      ...beforeArcs.map((a) => a.arcId.length),
    )
    const colW = 16

    const pad = (s: string, w: number): string => s.padEnd(w)
    const rpad = (s: string, w: number): string => s.padStart(w)

    deps.out(
      `${pad('arc-id', arcWidth)}  ${rpad('baseline', colW)}  ${rpad('treatment', colW)}  ${rpad('delta', colW)}`,
    )
    deps.out('─'.repeat(arcWidth + colW * 3 + 6))

    for (let i = 0; i < beforeArcs.length; i++) {
      const arc = beforeArcs[i]
      const afterArc = afterArcs[i]
      const baselineTokens = arc.tokensIn + arc.tokensOut
      const treatmentTokens = afterArc.tokensIn + afterArc.tokensOut
      const delta = treatmentTokens - baselineTokens
      const deltaStr = delta === 0 ? '0' : delta > 0 ? `+${delta}` : String(delta)
      deps.out(
        `${pad(arc.arcId, arcWidth)}  ${rpad(String(baselineTokens), colW)}  ${rpad(String(treatmentTokens), colW)}  ${rpad(deltaStr, colW)}`,
      )
    }

    return { code: 0 }
  },
}

export const toolForgeCommands: readonly Command[] = [
  toolForgeGroup,
  toolForgeScan,
  toolForgeBench,
]
