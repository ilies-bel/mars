/**
 * `reflect` (shallow, over a recent-task corpus) and the `arc` group
 * (`arc list`, `arc reflect` — deep reflection over a whole task arc).
 *
 * Reflection is gated by `MARS_REFLECT_DISABLED=1` per the orchestrator
 * convention. `insertReflectionTask` goes through `deps.store`.
 */

import type { Command, CommandDeps } from '../command'

const REFLECT_DISABLED_MSG = 'reflection disabled via MARS_REFLECT_DISABLED=1'

const reflect: Command = {
  path: 'reflect',
  summary: 'reflect over recent tasks and draft suggestions',
  usage: 'usage: mars reflect [--limit <n>] [--since <iso>]',
  run: async (args, deps) => {
    if (process.env.MARS_REFLECT_DISABLED === '1') {
      deps.out(REFLECT_DISABLED_MSG)
      return { code: 0 }
    }
    const limit = args.flags['--limit'] ? Number(args.flags['--limit']) : 10
    if (!Number.isFinite(limit) || limit <= 0) {
      deps.err('--limit must be a positive integer')
      return { code: 1 }
    }
    const sinceIso = args.flags['--since']
    const { loadRecentTaskCorpus } = await import('../../core/lib/reflect-query')
    const { runReflector, persistSuggestions } = await import(
      '../../core/lib/reflector'
    )
    const corpus = await loadRecentTaskCorpus({ sinceIso, limit })
    if (corpus.entries.length === 0) {
      deps.out('no completed tasks in window — nothing to reflect on')
      return { code: 0 }
    }
    const cs = corpus.costSummary
    deps.out(
      `reflecting over ${corpus.entries.length} task(s) — ${cs.totalWeightedTokens.toFixed(0)} weighted tokens (${cs.successCount} done / ${cs.failureCount} failed)…`,
    )
    const result = await runReflector(corpus)
    if (result.tokenAnalysis) {
      const ta = result.tokenAnalysis
      deps.out('\nToken analysis')
      if (ta.headline) deps.out(`  ${ta.headline}`)
      if (ta.cacheHealth) {
        deps.out(
          `  cache: ratio=${ta.cacheHealth.ratio.toFixed(2)} (${ta.cacheHealth.verdict}) — ${ta.cacheHealth.evidence}`,
        )
      }
      if (ta.successVsFailureTokens) {
        const s = ta.successVsFailureTokens
        deps.out(
          `  success vs failure tokens: ${s.successTokens} vs ${s.failureTokens} weighted tokens — ${s.verdict}`,
        )
      }
      for (const t of ta.tokenHeavyTasks) {
        deps.out(
          `  token-heavy task ${t.taskId}: ${t.weightedTokens} weighted tokens (${t.multipleOfMedian.toFixed(1)}× median) — ${t.rootCause}`,
        )
      }
      for (const s of ta.tokenHeavySteps) {
        deps.out(
          `  token-heavy step ${s.stepId}: ${s.totalWeightedTokens} weighted tokens (${s.verdict}) — ${s.evidence}`,
        )
      }
      if (ta.notes) deps.out(`  notes: ${ta.notes}`)
    }
    if (result.suggestions.length === 0) {
      deps.out('\nno suggestions produced')
      if (result.exitCode !== 0) {
        deps.err(`reflector exit code ${result.exitCode}`)
        return { code: 1 }
      }
      return { code: 0 }
    }
    const sourceTaskId = await deps.store.insertReflectionTask(
      corpus.entries.length,
    )
    await persistSuggestions(result.suggestions, sourceTaskId)
    deps.out('\nSuggestions')
    for (const s of result.suggestions) {
      deps.out(`- ${s.title}`)
      if (s.rationale) deps.out(`    ${s.rationale}`)
    }
    deps.out(
      `\n${result.suggestions.length} suggestion(s) saved as draft proposals (source='reflection'). Review with 'mars proposal list --source reflection' and promote with 'mars proposal promote <id>'.`,
    )
    return { code: 0 }
  },
}

const printArcRows = (
  deps: CommandDeps,
  candidates: ReadonlyArray<{
    originId: string
    taskCount: number
    statusMix: Record<string, number>
    totalTokens: number
    lastActivity: string
  }>,
): void => {
  deps.out('originId\ttasks\tdone\tfailed\ttokens\tlastActivity')
  for (const arc of candidates) {
    const done = arc.statusMix.done ?? 0
    const failed = arc.statusMix.failed ?? 0
    const tokens = arc.totalTokens.toLocaleString('en-US')
    deps.out(
      `${arc.originId}\t${arc.taskCount}\t${done}\t${failed}\t${tokens}\t${arc.lastActivity}`,
    )
  }
}

const arcList: Command = {
  path: 'arc list',
  summary: 'list deep-reflection arc candidates',
  usage: 'usage: mars arc list [--json] [--with-transcript-only] [--limit <n>]',
  run: async (args, deps) => {
    const { listDeepReflectArcCandidates } = await import(
      '../../core/lib/deep-reflect-query'
    )
    const emitJson = args.positional.includes('--json')
    const withTranscriptOnly = args.positional.includes('--with-transcript-only')

    let limit = 10
    const limitRaw = args.flags['--limit']
    if (limitRaw !== undefined) {
      const parsed = Number(limitRaw)
      if (!Number.isInteger(parsed) || Number.isNaN(parsed)) {
        deps.err(`--limit must be an integer; got '${limitRaw}'`)
        return { code: 1 }
      }
      limit = Math.min(100, Math.max(1, parsed))
    }

    const candidates = await listDeepReflectArcCandidates({
      limit,
      withTranscriptOnly,
    })

    if (emitJson) {
      deps.out(JSON.stringify(candidates, null, 2))
      return { code: 0 }
    }
    printArcRows(deps, candidates)
    return { code: 0 }
  },
}

const arcReflect: Command = {
  path: 'arc reflect',
  summary: 'deep-reflect over a whole task arc',
  usage: 'usage: mars arc reflect [<originId>]',
  run: async (args, deps) => {
    if (process.env.MARS_REFLECT_DISABLED === '1') {
      deps.out(REFLECT_DISABLED_MSG)
      return { code: 0 }
    }

    const inputId = args.positional.find((r) => !r.startsWith('--')) ?? null

    let chosenOriginInput: string
    if (inputId) {
      chosenOriginInput = inputId
    } else {
      const { listDeepReflectArcCandidates } = await import(
        '../../core/lib/deep-reflect-query'
      )
      const candidates = await listDeepReflectArcCandidates({
        limit: 10,
        withTranscriptOnly: false,
      })
      printArcRows(deps, candidates)

      const { createInterface } = await import('node:readline')
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      const answer = await new Promise<string>((resolve) => {
        let answered = false
        rl.question('Enter originId: ', (a) => {
          answered = true
          rl.close()
          resolve(a.trim())
        })
        rl.once('close', () => {
          if (!answered) resolve('')
        })
      })

      if (!answer) {
        deps.err('no arc selected; re-run with: mars arc reflect <originId>')
        return { code: 1 }
      }
      chosenOriginInput = answer
    }

    const { loadDeepReflectArc, resolveOriginIdForTaskOrSelf } = await import(
      '../../core/lib/deep-reflect-query'
    )
    const { runDeepReflectorArc } = await import('../../core/lib/deep-reflector')
    const { applyVerdicts } = await import('../../core/lib/reflector')

    const originId = await resolveOriginIdForTaskOrSelf(chosenOriginInput)
    const arc = await loadDeepReflectArc(originId)
    if (!arc) {
      deps.err(`no arc found for ${originId}`)
      return { code: 1 }
    }

    const statusMixStr = Object.entries(arc.statusMix)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    deps.out(
      `arc ${originId}: ${arc.taskCount} task(s) [${statusMixStr}], ${arc.totals.eventCount} event(s), ${arc.totals.totalWeightedTokens.toFixed(0)} weighted tokens total`,
    )
    for (const t of arc.tasks) {
      const weightedTokens = Math.round(
        t.totals.inputTokens +
          t.totals.outputTokens +
          t.totals.cacheCreateTokens +
          t.totals.cacheReadTokens * 0.1,
      )
      deps.out(`  task ${t.taskId} [${t.status}]: weighted-tokens=${weightedTokens}`)
      for (const note of t.transcriptNotes) {
        deps.out(`  note (${t.taskId}): ${note}`)
      }
    }

    const result = await runDeepReflectorArc(arc)
    const report = result.report

    const sourceTaskId = await deps.store.insertReflectionTask(1)
    const verdictResult = await applyVerdicts(report.suggestions, sourceTaskId)

    const { mkdir, writeFile } = await import('node:fs/promises')
    const { resolve: resolvePath } = await import('node:path')
    const { getStateDir } = await import('../../core/context')
    const outDir = resolvePath(getStateDir(), 'deep-reflections')
    await mkdir(outDir, { recursive: true })
    const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = resolvePath(outDir, `arc-${originId}-${isoStamp}.json`)
    const fullDoc = {
      originId,
      recordedAt: new Date().toISOString(),
      report,
      sourceTaskId,
      verdictResult: {
        saved: verdictResult.saved,
        absorbed: verdictResult.absorbed,
        dropped: verdictResult.dropped,
      },
      rawOutput: result.rawOutput,
    }
    await writeFile(outPath, JSON.stringify(fullDoc, null, 2), 'utf8')

    deps.out('')
    if (report.summary) deps.out(`Summary: ${report.summary}`)
    deps.out(
      `Tool calls: ${report.toolCallStats.total} total — ${
        Object.entries(report.toolCallStats.byName)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ') || 'none'
      }`,
    )
    const mismatchCount =
      (report.verifyMismatches?.length ?? 0) > 0
        ? report.verifyMismatches!.length
        : report.verifyMismatch
          ? 1
          : 0
    deps.out(
      `Dissonant calls: ${report.dissonantCalls.length}${
        mismatchCount > 0 ? ` | verify mismatches: ${mismatchCount}` : ''
      }`,
    )
    if (report.dissonantCalls.length > 0) {
      deps.out('Top dissonant calls:')
      for (const d of report.dissonantCalls.slice(0, 3)) {
        const taskRef = d.taskId ? ` [${d.taskId}]` : ''
        deps.out(
          `  [${d.severity}] event ${d.eventIndex}${taskRef} ${d.tool}: ${d.statedIntent} → ${d.actualOutcome}`,
        )
      }
    }
    if (report.rootCause) deps.out(`Root cause: ${report.rootCause}`)
    deps.out(
      `Suggestions: ${verdictResult.saved} saved, ${verdictResult.absorbed} absorbed, ${verdictResult.dropped} dropped`,
    )
    deps.out(`Full report: ${outPath}`)
    if (result.exitCode !== 0) {
      deps.err(`deep-reflector exit code ${result.exitCode}`)
    }
    return { code: 0 }
  },
}

const arcGroup: Command = {
  path: 'arc',
  summary: 'arc subcommands',
  usage: 'usage: mars arc <list|reflect> ...',
  run: (_args, deps) => {
    deps.err('usage: mars arc <list|reflect> ...')
    return { code: 1 }
  },
}

export const reflectCommands: readonly Command[] = [
  reflect,
  arcList,
  arcReflect,
  arcGroup,
]
