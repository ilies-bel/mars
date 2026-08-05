/**
 * `reflect` (shallow, over a recent-task corpus) and the `arc` group
 * (`arc list`, `arc reflect` — deep reflection over a whole task arc).
 *
 * Reflection is gated by `MARS_REFLECT_DISABLED=1` per the orchestrator
 * convention. `insertReflectionTask` goes through `deps.store`.
 */

import type { Command, CommandDeps } from '../command'
import { hasFlag } from '../args'
import { errorMessage } from './shared'

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
    // Surface KPI baseline so the operator can see whether reflect has cost
    // data to compare against, and flag staleness when the daemon has stopped
    // taking snapshots (the feed should update hourly when the daemon is live).
    const { readLatestKpiSnapshot } = await import('../../core/lib/kpi-snapshots.js')
    const kpiSnap = await readLatestKpiSnapshot(deps.store)
    if (kpiSnap === null) {
      deps.out('KPI snapshots: none — start the daemon to begin capturing hourly baselines')
    } else {
      const staleThresholdMs = 48 * 60 * 60 * 1000
      const snapAgeMs = Date.now() - new Date(kpiSnap.taken_at).getTime()
      if (snapAgeMs > staleThresholdMs) {
        deps.out(`KPI snapshots stale since ${kpiSnap.taken_at} — restart the daemon to resume capture`)
      } else {
        const fmt = (v: number | null, digits = 3): string =>
          v === null ? 'n/a' : v.toFixed(digits)
        deps.out(
          `KPI snapshot ${kpiSnap.taken_at}: failure_rate=${fmt(kpiSnap.failure_rate)} autonomous_completion=${fmt(kpiSnap.autonomous_completion_rate)} recovery_success=${fmt(kpiSnap.recovery_success_rate)} cost_per_arc_p50=${fmt(kpiSnap.cost_per_arc_p50, 0)}`,
        )
      }
    }
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
    const { runSkillForgeScan } = await import('./skill-forge')
    const sfRes = await runSkillForgeScan()
    deps.out(`skill-forge: filed ${sfRes.filed} draft(s)`)
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
    const emitJson = hasFlag(args, '--json')
    const withTranscriptOnly = hasFlag(args, '--with-transcript-only')

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
    const { applyVerdicts, applyScorerVerdicts, applyCapabilityGapVerdicts } =
      await import('../../core/lib/reflector')

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

    // Compute the report path BEFORE applying scorer verdicts: the persisted
    // scorers row carries it as provenance (origin_arc_id + report_path).
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { resolve: resolvePath } = await import('node:path')
    const { getStateDir } = await import('../../core/context')
    const outDir = resolvePath(getStateDir(), 'deep-reflections')
    await mkdir(outDir, { recursive: true })
    const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = resolvePath(outDir, `arc-${originId}-${isoStamp}.json`)

    if (result.exitCode !== 0) {
      await writeFile(
        outPath,
        JSON.stringify(
          {
            originId,
            recordedAt: new Date().toISOString(),
            status: 'partial',
            reflectorExitCode: result.exitCode,
            report,
            rawOutput: result.rawOutput,
          },
          null,
          2,
        ),
        'utf8',
      )
      deps.err(
        `deep-reflector failed (exit ${result.exitCode}) — analysis is partial/unusable; stats suppressed`,
      )
      deps.out(`Partial report: ${outPath}`)
      return { code: 1 }
    }

    const sourceTaskId = await deps.store.insertReflectionTask(1)
    const verdictResult = await applyVerdicts(report.suggestions, sourceTaskId)
    const scorerVerdictResult = await applyScorerVerdicts(
      report.scorerSuggestions,
      { originArcId: originId, reportPath: outPath },
    )
    const capabilityGapResult = await applyCapabilityGapVerdicts(
      report.capabilityGapSuggestions,
      { originArcId: originId },
    )

    await writeFile(
      outPath,
      JSON.stringify(
        {
          originId,
          recordedAt: new Date().toISOString(),
          status: 'complete',
          report,
          sourceTaskId,
          verdictResult: {
            saved: verdictResult.saved,
            absorbed: verdictResult.absorbed,
            dropped: verdictResult.dropped,
          },
          scorerVerdictResult: {
            suggested: scorerVerdictResult.suggested,
            absorbed: scorerVerdictResult.absorbed,
            dropped: scorerVerdictResult.dropped,
            suggestedScorerIds: scorerVerdictResult.suggestedScorerIds,
          },
          capabilityGapResult: {
            saved: capabilityGapResult.saved,
            absorbed: capabilityGapResult.absorbed,
            dropped: capabilityGapResult.dropped,
            proposalIds: capabilityGapResult.proposalIds,
          },
          rawOutput: result.rawOutput,
        },
        null,
        2,
      ),
      'utf8',
    )

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
    deps.out(
      `Scorer suggestions: ${scorerVerdictResult.suggested} suggested, ${scorerVerdictResult.absorbed} absorbed, ${scorerVerdictResult.dropped} dropped`,
    )
    for (const scorerId of scorerVerdictResult.suggestedScorerIds) {
      deps.out(
        `  suggested Scorer ${scorerId} — review with 'mars scorer show ${scorerId}'`,
      )
    }
    deps.out(
      `Capability gaps: ${capabilityGapResult.saved} saved, ${capabilityGapResult.absorbed} absorbed, ${capabilityGapResult.dropped} dropped`,
    )
    for (const proposalId of capabilityGapResult.proposalIds) {
      deps.out(
        `  capability-gap draft ${proposalId} — review with 'mars proposal show ${proposalId}'`,
      )
    }
    deps.out(`Full report: ${outPath}`)
    return { code: 0 }
  },
}

const arcPurge: Command = {
  path: 'arc purge',
  summary: 'purge a whole task arc (origin + all same-origin siblings)',
  usage: 'usage: mars arc purge <id> [--force]',
  run: async (args, deps) => {
    const positionals = args.positional.filter((a) => !a.startsWith('--'))
    const id = positionals[0]
    if (!id) {
      deps.err('usage: mars arc purge <id> [--force]')
      return { code: 1 }
    }
    const force = hasFlag(args, '--force')
    let result: { purgedIds: string[]; originId: string }
    try {
      result = (await deps.daemon.sendRequest({
        op: 'arc-purge',
        id,
        force,
      })) as { purgedIds: string[]; originId: string }
    } catch (err) {
      deps.err(`${id}: ${errorMessage(err)}`)
      return { code: 1 }
    }
    for (const purgedId of result.purgedIds) {
      deps.out(`purged ${purgedId}`)
    }
    deps.out(`purged arc ${result.originId} (${result.purgedIds.length} task${result.purgedIds.length === 1 ? '' : 's'})`)
    return { code: 0 }
  },
}

const arcGroup: Command = {
  path: 'arc',
  summary: 'arc subcommands',
  usage: 'usage: mars arc <list|purge|reflect> ...',
  run: (_args, deps) => {
    deps.err('usage: mars arc <list|purge|reflect> ...')
    return { code: 1 }
  },
}

const sessionReflect: Command = {
  path: 'reflect session',
  summary: 'session-scoped reflection: step fitness and resource spend',
  usage: 'usage: mars reflect session [<sessionId>|<originId>]',
  run: async (args, deps) => {
    if (process.env.MARS_REFLECT_DISABLED === '1') {
      deps.out(REFLECT_DISABLED_MSG)
      return { code: 0 }
    }

    // Resolve the session to reflect on.
    // Priority: explicit arg → CLAUDE_CODE_SESSION_ID env var.
    const inputArg = args.positional.find((a) => !a.startsWith('--')) ?? null
    const envSessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim() ?? ''

    let rawInput: string
    if (inputArg) {
      rawInput = inputArg
    } else if (envSessionId) {
      rawInput = envSessionId
    } else {
      deps.err(
        'no session to reflect on — pass a <sessionId> or <originId>, or run inside a Claude Code session (CLAUDE_CODE_SESSION_ID must be set)',
      )
      return { code: 1 }
    }

    const { resolveSessionId, loadSessionArcs } = await import(
      '../../core/lib/deep-reflect-query'
    )
    const { runSessionReflector } = await import('../../core/lib/deep-reflector')
    const { applyVerdicts } = await import('../../core/lib/reflector')

    const sessionId = await resolveSessionId(rawInput)
    if (!sessionId) {
      deps.err(
        `no session found for '${rawInput}' — the task may not have been enqueued from a Claude Code session, or the ID is unknown`,
      )
      return { code: 1 }
    }

    const sessionResult = await loadSessionArcs(sessionId)
    if (!sessionResult) {
      deps.err(
        `no tasks found for session ${sessionId} — nothing to reflect on`,
      )
      return { code: 1 }
    }

    const { arcs } = sessionResult
    const totalWeightedTokens = arcs.reduce(
      (s, a) => s + a.totals.totalWeightedTokens,
      0,
    )
    deps.out(
      `reflecting on session ${sessionId}: ${arcs.length} arc(s), ${totalWeightedTokens.toFixed(0)} weighted tokens total`,
    )
    for (const arc of arcs) {
      const statusMixStr = Object.entries(arc.statusMix)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')
      deps.out(
        `  arc ${arc.originId}: ${arc.taskCount} task(s) [${statusMixStr}], ${arc.totals.totalWeightedTokens.toFixed(0)} weighted tokens`,
      )
    }
    if (sessionResult.stepRuns.length > 0) {
      const retriedSteps = sessionResult.stepRuns.filter((s) => s.attempt > 1)
      if (retriedSteps.length > 0) {
        deps.out(
          `  ${retriedSteps.length} retried step(s): ${retriedSteps.map((s) => `${s.stepName}(attempt=${s.attempt})`).join(', ')}`,
        )
      }
    }

    const result = await runSessionReflector(sessionResult)
    const report = result.report

    const { mkdir, writeFile } = await import('node:fs/promises')
    const { resolve: resolvePath } = await import('node:path')
    const { getStateDir } = await import('../../core/context')
    const outDir = resolvePath(getStateDir(), 'deep-reflections')
    await mkdir(outDir, { recursive: true })
    const isoStamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = resolvePath(
      outDir,
      `session-${sessionId.slice(0, 8)}-${isoStamp}.json`,
    )

    if (result.exitCode !== 0) {
      await writeFile(
        outPath,
        JSON.stringify(
          {
            sessionId,
            recordedAt: new Date().toISOString(),
            status: 'partial',
            reflectorExitCode: result.exitCode,
            arcCount: arcs.length,
            report,
            rawOutput: result.rawOutput,
          },
          null,
          2,
        ),
        'utf8',
      )
      deps.err(
        `session reflector failed (exit ${result.exitCode}) — analysis is partial/unusable; stats suppressed`,
      )
      deps.out(`Partial report: ${outPath}`)
      return { code: 1 }
    }

    const sourceTaskId = await deps.store.insertReflectionTask(arcs.length)
    const verdictResult = await applyVerdicts(report.suggestions, sourceTaskId)

    await writeFile(
      outPath,
      JSON.stringify(
        {
          sessionId,
          recordedAt: new Date().toISOString(),
          status: 'complete',
          arcCount: arcs.length,
          report,
          sourceTaskId,
          verdictResult: {
            saved: verdictResult.saved,
            absorbed: verdictResult.absorbed,
            dropped: verdictResult.dropped,
          },
          rawOutput: result.rawOutput,
        },
        null,
        2,
      ),
      'utf8',
    )

    deps.out('')
    if (report.summary) deps.out(`Summary: ${report.summary}`)
    if (report.rootCause) deps.out(`Root cause: ${report.rootCause}`)
    if (report.thrashingPatterns.length > 0) {
      deps.out('Harness patterns:')
      for (const p of report.thrashingPatterns) {
        deps.out(`  [${p.occurrences}×] ${p.pattern}`)
      }
    }
    deps.out(
      `Suggestions: ${verdictResult.saved} saved, ${verdictResult.absorbed} absorbed, ${verdictResult.dropped} dropped`,
    )
    deps.out(`Full report: ${outPath}`)
    if (verdictResult.saved > 0) {
      deps.out(
        `Draft proposals created. Review with 'mars proposal list --source reflection' and promote with 'mars proposal promote <id>'.`,
      )
    }
    return { code: 0 }
  },
}

const reflectWorkflowFit: Command = {
  path: 'reflect workflow-fit',
  summary: 'evaluate workflow step fitness and token spend for a session arc',
  usage: 'usage: mars reflect workflow-fit [<sessionId>|<originId>] [--dry-run]',
  run: async (args, deps) => {
    if (process.env.MARS_REFLECT_DISABLED === '1') {
      deps.out(REFLECT_DISABLED_MSG)
      return { code: 0 }
    }

    const dryRun = hasFlag(args, '--dry-run')
    const inputArg = args.positional.find((a) => !a.startsWith('--')) ?? null
    const envSessionId = process.env.CLAUDE_CODE_SESSION_ID?.trim() ?? ''

    let rawInput: string
    if (inputArg) {
      rawInput = inputArg
    } else if (envSessionId) {
      rawInput = envSessionId
    } else {
      deps.err(
        'no session to reflect on — pass a <sessionId> or <originId>, or run inside a Claude Code session (CLAUDE_CODE_SESSION_ID must be set)',
      )
      return { code: 1 }
    }

    const { resolveSessionId, loadSessionArcs } = await import(
      '../../core/lib/deep-reflect-query'
    )
    const { evaluateWorkflowFit } = await import(
      '../../core/reflect-workflow-fit'
    )

    const sessionId = await resolveSessionId(rawInput)
    if (!sessionId) {
      deps.err(
        `no session found for '${rawInput}' — the task may not have been enqueued from a Claude Code session, or the ID is unknown`,
      )
      return { code: 1 }
    }

    const sessionResult = await loadSessionArcs(sessionId)
    if (!sessionResult) {
      deps.err(`no tasks found for session ${sessionId} — nothing to reflect on`)
      return { code: 1 }
    }

    const { arcs, stepRuns } = sessionResult
    const totalWeightedTokens = arcs.reduce(
      (s, a) => s + a.totals.totalWeightedTokens,
      0,
    )
    deps.out(
      `evaluating workflow fit for session ${sessionId}: ${arcs.length} arc(s), ${totalWeightedTokens.toFixed(0)} weighted tokens, ${stepRuns.length} step run(s)`,
    )

    const specs = evaluateWorkflowFit({ sessionId, arcs, stepRuns })

    if (specs.length === 0) {
      deps.out('no workflow-fit outliers detected')
      return { code: 0 }
    }

    if (dryRun) {
      deps.out(`\n[dry-run] ${specs.length} proposal(s) would be created:`)
      for (const s of specs) {
        deps.out(`  - ${s.title} (kpi=${s.kpiTag})`)
        deps.out(`    ${s.solution}`)
      }
      return { code: 0 }
    }

    const { createProposal } = await import('../../core/proposals')
    for (const spec of specs) {
      await createProposal(spec.title, {
        source: 'reflection',
        solution: spec.solution,
        notes: spec.notes,
        kpiTag: spec.kpiTag,
      })
    }

    deps.out('\nWorkflow-fit proposals')
    for (const s of specs) {
      deps.out(`- ${s.title}`)
      deps.out(`  ${s.solution}`)
    }
    deps.out(
      `\n${specs.length} proposal(s) saved as draft proposals (source='reflection'). Review with 'mars proposal list --source reflection'.`,
    )
    return { code: 0 }
  },
}

export const reflectCommands: readonly Command[] = [
  reflect,
  sessionReflect,
  reflectWorkflowFit,
  arcList,
  arcPurge,
  arcReflect,
  arcGroup,
]
