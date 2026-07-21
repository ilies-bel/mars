import { defineWorkflow, runWorkflow, type WorkflowEvent } from '@mars/workflow'
import { z } from 'zod'
import { loadDeepReflectArc } from '../core/lib/deep-reflect-query'
import type { DeepReflectArc } from '../core/lib/deep-reflect-query'
import { digestArc, type ArcDigest } from '../core/lib/arc-digest'
import {
  buildArcPrompt,
  parseDeepReflectionReport,
  resolveArcDomain,
  type DeepReflectionReport,
} from '../core/lib/deep-reflector'
import { runClaudeCode } from '../core/lib/git/claude'
import { collectAssistantText } from '../core/lib/reflector'
import { insertMemoryPacket } from '../core/store/memory-packet-store'
import { getRepoRoot } from '../core/context'
import { createQueueWorkflowStore } from './queue-workflow-store'
import { runNonLlmStepWithSpan } from '../core/lib/run-worker-with-span'
import type {
  TraceEventPhase,
  TraceEventStore,
} from '../core/lib/trace-events-store'
import { nullTraceStore } from '../core/lib/run-tool'

// ─── Finding types ──────────────────────────────────────────────────────────

export interface TokenEconomyFindings {
  repeatedReads: Array<{ path: string; count: number; estimatedWastedTokens: number }>
  failedToolCalls: {
    count: number
    firstCallFailed: boolean
    firstCallName: string | null
  }
  editRevertChurn: {
    pairCount: number
    estimatedWastedTokens: number
  }
  repeatedBashInvocations: Array<{ argv: string; count: number }>
  totalEstimatedWaste: number
}

export interface PatternOpportunity {
  tool: string
  currentUsage: number
  alternativeUsage: number
  ratio: number
  suggestion: string
}

export interface PatternFindings {
  codegraphAdoption: { used: number; missed: number; ratio: number }
  rtkAdoption: { rtkCommands: number; rawCommands: number }
  skillsUsed: string[]
  agentDelegation: { agentCalls: number }
  opportunities: PatternOpportunity[]
}

export interface WorkflowFitnessEntry {
  step: string
  worker: string
  recommended: string
  durationMs: number
}

export interface WorkflowFitnessFindings {
  modelSizing: WorkflowFitnessEntry[]
  verifyStepPresent: boolean
  verifyOutcome: string | null
  concurrency: { maxConcurrent: number; totalSpans: number }
  durationAnomalies: Array<{ step: string; durationMs: number }>
}

export interface SystemPromptSection {
  name: string
  estimatedTokens: number
}

export interface SystemPromptFindings {
  sections: SystemPromptSection[]
  totalSystemPromptTokens: number
  taskPromptTokens: number
  systemToTaskRatio: number
}

export interface TaskKpi {
  taskId: string
  status: string
  inputTokens: number
  outputTokens: number
  weightedTokens: number
  turnCount: number
  tokensPerTurn: number
  cacheHitRatio: number
}

export interface KpiFindings {
  perTask: TaskKpi[]
  arcTotals: {
    weightedTokens: number
    turnCount: number
    tokensPerTurn: number
    cacheHitRatio: number
  }
  tooLargeSignals: Array<{ taskId: string; reason: string }>
  slicingDiagnosis: string | null
}

export interface ReflectStepFindings {
  tokenEconomy: TokenEconomyFindings
  patterns: PatternFindings
  workflowFitness: WorkflowFitnessFindings
  systemPrompt: SystemPromptFindings
  kpis: KpiFindings
}

export interface ReflectOutput {
  report: DeepReflectionReport
  stepFindings: ReflectStepFindings
  rawOutput: string
  exitCode: number
}

// ─── Waste-estimate coefficients ────────────────────────────────────────────
// Rough per-occurrence token costs. Deliberately coarse: the point is to rank
// waste sources against each other, not to bill anyone.

const TOKENS_PER_READ = 500
const TOKENS_PER_FAILED_CALL = 200
const TOKENS_PER_EDIT_REVERT = 1000
const TOKENS_PER_BASH_REPEAT = 300

const analyzeTokenEconomy = (digest: ArcDigest): TokenEconomyFindings => {
  const aggregatedReads = new Map<string, number>()
  const bashAgg = new Map<string, number>()
  let totalFailedCalls = 0
  let totalEditReverts = 0
  let anyFirstCallFailed = false
  let firstCallFailedName: string | null = null

  for (const td of digest.tasks) {
    // The digest counts total occurrences; only the excess over the first is waste.
    for (const rr of td.repeatedReads) {
      aggregatedReads.set(rr.path, (aggregatedReads.get(rr.path) ?? 0) + (rr.count - 1))
    }
    for (const rb of td.repeatedBashInvocations) {
      bashAgg.set(rb.argv, (bashAgg.get(rb.argv) ?? 0) + (rb.count - 1))
    }
    totalFailedCalls += td.toolErrorCount
    totalEditReverts += td.editRevertPairCount
    if (td.firstToolCallFailed && !anyFirstCallFailed) {
      anyFirstCallFailed = true
      firstCallFailedName = td.firstToolCallName
    }
  }

  const repeatedReads = Array.from(aggregatedReads.entries())
    .map(([path, count]) => ({
      path,
      count,
      estimatedWastedTokens: count * TOKENS_PER_READ,
    }))
    .sort((a, b) => b.estimatedWastedTokens - a.estimatedWastedTokens)

  const repeatedBashInvocations = Array.from(bashAgg.entries())
    .map(([argv, count]) => ({ argv, count }))
    .sort((a, b) => b.count - a.count)

  const totalEstimatedWaste =
    repeatedReads.reduce((s, r) => s + r.estimatedWastedTokens, 0) +
    totalFailedCalls * TOKENS_PER_FAILED_CALL +
    totalEditReverts * TOKENS_PER_EDIT_REVERT +
    repeatedBashInvocations.reduce((s, r) => s + r.count * TOKENS_PER_BASH_REPEAT, 0)

  return {
    repeatedReads,
    failedToolCalls: {
      count: totalFailedCalls,
      firstCallFailed: anyFirstCallFailed,
      firstCallName: firstCallFailedName,
    },
    editRevertChurn: {
      pairCount: totalEditReverts,
      estimatedWastedTokens: totalEditReverts * TOKENS_PER_EDIT_REVERT,
    },
    repeatedBashInvocations,
    totalEstimatedWaste,
  }
}

const CODEGRAPH_TOOLS = [
  'codegraph_explore',
  'codegraph_search',
  'codegraph_node',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
]

/** Below this share of exploration calls, codegraph counts as under-adopted. */
const CODEGRAPH_ADOPTION_FLOOR = 0.2

const analyzePatterns = (arc: DeepReflectArc, digest: ArcDigest): PatternFindings => {
  const totalCounts: Record<string, number> = {}
  for (const t of arc.tasks) {
    for (const [tool, count] of Object.entries(t.toolCallCounts)) {
      totalCounts[tool] = (totalCounts[tool] ?? 0) + count
    }
  }

  // Codegraph surfaces under two naming schemes depending on how it was wired
  // (MCP-prefixed vs bare). Count both.
  const codegraphMcpCalls = Object.entries(totalCounts)
    .filter(([k]) => k.startsWith('mcp__codegraph__'))
    .reduce((s, [, v]) => s + v, 0)
  const codegraphDirectCalls = CODEGRAPH_TOOLS.reduce(
    (s, name) => s + (totalCounts[name] ?? 0),
    0,
  )
  const totalCodegraph = codegraphMcpCalls + codegraphDirectCalls

  const readCalls = totalCounts.Read ?? 0
  const grepCalls = (totalCounts.Grep ?? 0) + (totalCounts.Glob ?? 0)
  const totalExploration = readCalls + grepCalls + totalCodegraph
  const codegraphRatio = totalExploration > 0 ? totalCodegraph / totalExploration : 0

  let rtkCommands = 0
  let rawCommands = 0
  for (const td of digest.tasks) {
    for (const rb of td.repeatedBashInvocations) {
      if (rb.argv.startsWith('rtk ')) rtkCommands += rb.count
      else if (/^(git |npm |npx |pnpm )/.test(rb.argv)) rawCommands += rb.count
    }
  }

  const agentCalls = totalCounts.Agent ?? 0
  const opportunities: PatternOpportunity[] = []

  if (codegraphRatio < CODEGRAPH_ADOPTION_FLOOR && readCalls + grepCalls > 10) {
    opportunities.push({
      tool: 'codegraph',
      currentUsage: totalCodegraph,
      alternativeUsage: readCalls + grepCalls,
      ratio: codegraphRatio,
      suggestion: `codegraph used ${totalCodegraph}× vs ${readCalls + grepCalls} Read+Grep — codegraph_explore replaces most Read+Grep sweeps`,
    })
  }

  if (rawCommands > 5 && rtkCommands === 0) {
    opportunities.push({
      tool: 'rtk',
      currentUsage: rtkCommands,
      alternativeUsage: rawCommands,
      ratio: 0,
      suggestion: `${rawCommands} raw git/npm commands, 0 rtk — rtk saves 60-90% tokens on dev operations`,
    })
  }

  if (agentCalls === 0 && readCalls > 20) {
    opportunities.push({
      tool: 'Agent (fork)',
      currentUsage: 0,
      alternativeUsage: readCalls,
      ratio: 0,
      suggestion: `${readCalls} Read calls with 0 Agent forks — forking exploration keeps tool output out of the main context`,
    })
  }

  return {
    codegraphAdoption: {
      used: totalCodegraph,
      missed: readCalls + grepCalls,
      ratio: codegraphRatio,
    },
    rtkAdoption: { rtkCommands, rawCommands },
    skillsUsed: (totalCounts.Skill ?? 0) > 0 ? ['Skill'] : [],
    agentDelegation: { agentCalls },
    opportunities,
  }
}

/** Per-Worker model pins from CLAUDE.md; used to flag drift, not to enforce. */
const RECOMMENDED_MODELS: Record<string, string> = {
  Coder: 'claude-sonnet-4-6',
  Fixer: 'claude-sonnet-4-6',
  Writer: 'claude-haiku-4-5-20251001',
  Planner: 'claude-opus-4-7',
  Slicer: 'claude-opus-4-7',
  Triager: 'claude-sonnet-4-6',
}

/** A step slower than this multiple of its own kind's median is an anomaly. */
const DURATION_ANOMALY_FACTOR = 2

const analyzeWorkflowFitness = (arc: DeepReflectArc): WorkflowFitnessFindings => {
  const modelSizing: WorkflowFitnessEntry[] = arc.stepTimeline.map((s) => ({
    step: s.stepName,
    worker: s.workerName ?? 'unknown',
    recommended: RECOMMENDED_MODELS[s.workerName ?? ''] ?? 'claude-sonnet-4-6',
    durationMs: s.durationMs,
  }))

  const verifySteps = arc.stepTimeline.filter(
    (s) => s.stepName === 'verify' || s.stepName === 'behaviour-verify',
  )

  // Peak concurrency = the largest set of spans overlapping any single span.
  const spans = arc.stepTimeline.map((s) => {
    const start = new Date(s.startedAt).getTime()
    return { start, end: start + s.durationMs }
  })
  let maxConcurrent = 0
  for (const span of spans) {
    const concurrent = spans.filter((s) => s.start < span.end && s.end > span.start).length
    maxConcurrent = Math.max(maxConcurrent, concurrent)
  }

  const byStep = new Map<string, number[]>()
  for (const s of arc.stepTimeline) {
    const arr = byStep.get(s.stepName) ?? []
    arr.push(s.durationMs)
    byStep.set(s.stepName, arr)
  }

  const durationAnomalies = arc.stepTimeline
    .filter((s) => {
      const durations = byStep.get(s.stepName) ?? []
      // A single sample has no median to deviate from.
      if (durations.length < 2) return false
      const sorted = [...durations].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]
      return s.durationMs > median * DURATION_ANOMALY_FACTOR
    })
    .map((s) => ({ step: s.stepName, durationMs: s.durationMs }))

  return {
    modelSizing,
    verifyStepPresent: verifySteps.length > 0,
    verifyOutcome: verifySteps[0]?.outcome ?? null,
    concurrency: { maxConcurrent, totalSpans: arc.stepTimeline.length },
    durationAnomalies,
  }
}

/** Rough chars-per-token for prompt-size estimates. */
const CHARS_PER_TOKEN = 4

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** Sum the length of every `<system-reminder>` block in a text blob. */
const reminderChars = (text: string): number =>
  (text.match(SYSTEM_REMINDER_RE) ?? []).reduce((s, r) => s + r.length, 0)

/**
 * Estimate how much of the first task's context was framing (system prompt +
 * injected reminders) rather than the task itself. A high system/task ratio
 * means the agent paid for a lot of boilerplate to do a small job.
 */
const analyzeSystemPrompt = (arc: DeepReflectArc): SystemPromptFindings => {
  const firstTask = arc.tasks[0]
  if (!firstTask?.conversation?.length) {
    return {
      sections: [],
      totalSystemPromptTokens: 0,
      taskPromptTokens: 0,
      systemToTaskRatio: 0,
    }
  }

  let systemPromptChars = 0
  const sections: SystemPromptSection[] = []

  for (const event of firstTask.conversation) {
    if (event.type === 'system') {
      // `system`/`init` events carry no `message` — their framing (tool list,
      // MCP servers, cwd) sits directly on the event, and that payload is
      // exactly the boilerplate this step exists to measure. Fall back to the
      // whole event, and guard the stringify: JSON.stringify(undefined) is
      // itself undefined, not a string.
      const raw = event.message ?? event
      const content = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? '')
      systemPromptChars += content.length
      for (const header of content.match(/^#+\s+.+$/gm) ?? []) {
        sections.push({ name: header.replace(/^#+\s+/, '').trim(), estimatedTokens: 0 })
      }
      continue
    }

    // Reminders ride inside user turns, as either a bare string or text blocks.
    if (event.type !== 'user') continue
    const msg = event.message
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue
    const content = (msg as Record<string, unknown>).content

    if (typeof content === 'string') {
      systemPromptChars += reminderChars(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') {
        systemPromptChars += reminderChars(b.text)
      }
    }
  }

  const totalSystemPromptTokens = Math.ceil(systemPromptChars / CHARS_PER_TOKEN)
  const taskPromptTokens = Math.ceil(firstTask.prompt.length / CHARS_PER_TOKEN)

  return {
    sections,
    totalSystemPromptTokens,
    taskPromptTokens,
    systemToTaskRatio: taskPromptTokens > 0 ? totalSystemPromptTokens / taskPromptTokens : 0,
  }
}

// Thresholds above which a task looks mis-sliced rather than merely large.
const TOO_MANY_TURNS = 200
const TOO_MANY_TOKENS = 500_000
const TOO_MANY_RECOVERIES = 3

const computeKpis = (arc: DeepReflectArc, digest: ArcDigest): KpiFindings => {
  const perTask: TaskKpi[] = arc.tasks.map((t, idx) => {
    const td = digest.tasks[idx]
    // Cache reads are ~10% the cost of fresh input tokens.
    const weightedTokens = Math.round(
      t.totals.inputTokens +
        t.totals.outputTokens +
        t.totals.cacheCreateTokens +
        t.totals.cacheReadTokens * 0.1,
    )
    const turnCount = td?.turnCount ?? 0
    return {
      taskId: t.taskId,
      status: t.status,
      inputTokens: t.totals.inputTokens,
      outputTokens: t.totals.outputTokens,
      weightedTokens,
      turnCount,
      tokensPerTurn: turnCount > 0 ? Math.round(weightedTokens / turnCount) : 0,
      cacheHitRatio: t.totals.cacheHitRatio,
    }
  })

  const totalWeighted = arc.totals.totalWeightedTokens
  const totalTurns = digest.tasks.reduce((s, td) => s + td.turnCount, 0)

  const tooLargeSignals: Array<{ taskId: string; reason: string }> = []
  for (const t of perTask) {
    const reasons: string[] = []
    if (t.turnCount > TOO_MANY_TURNS) {
      reasons.push(`${t.turnCount} turns (threshold: ${TOO_MANY_TURNS})`)
    }
    if (t.weightedTokens > TOO_MANY_TOKENS) {
      reasons.push(`${t.weightedTokens} weighted tokens (threshold: ${TOO_MANY_TOKENS})`)
    }
    if (reasons.length > 0) {
      tooLargeSignals.push({ taskId: t.taskId, reason: reasons.join('; ') })
    }
  }

  const recoveryCount = arc.tasks.filter((t) => t.kind === 'fix').length
  if (recoveryCount >= TOO_MANY_RECOVERIES) {
    tooLargeSignals.push({
      taskId: arc.originId,
      reason: `${recoveryCount} recovery tasks spawned (threshold: ${TOO_MANY_RECOVERIES}) — likely a slicing issue`,
    })
  }

  let slicingDiagnosis: string | null = null
  if (tooLargeSignals.length > 0) {
    const highTurnTasks = perTask.filter((t) => t.turnCount > TOO_MANY_TURNS)
    const highTokenTasks = perTask.filter((t) => t.weightedTokens > TOO_MANY_TOKENS)
    if (recoveryCount >= TOO_MANY_RECOVERIES) {
      slicingDiagnosis = `Arc spawned ${recoveryCount} recovery tasks — the original task was likely too broad, or hit a repeated environment issue`
    } else if (highTurnTasks.length > 0) {
      slicingDiagnosis = `${highTurnTasks.length} task(s) exceeded ${TOO_MANY_TURNS} turns — consider splitting into smaller, focused tasks`
    } else if (highTokenTasks.length > 0) {
      slicingDiagnosis = `${highTokenTasks.length} task(s) exceeded ${TOO_MANY_TOKENS} weighted tokens — consider constraining scope or using --files`
    }
  }

  return {
    perTask,
    arcTotals: {
      weightedTokens: Math.round(totalWeighted),
      turnCount: totalTurns,
      tokensPerTurn: totalTurns > 0 ? Math.round(totalWeighted / totalTurns) : 0,
      cacheHitRatio: arc.totals.cacheHitRatio,
    },
    tooLargeSignals,
    slicingDiagnosis,
  }
}

// ─── Synthesis prompt preamble ──────────────────────────────────────────────

/**
 * Render the mechanical findings as a preamble to the analyst prompt. The
 * synthesis step is told to treat these as authoritative rather than
 * re-deriving them from the raw conversation.
 */
const buildFindingsPreamble = (findings: ReflectStepFindings): string => {
  const { tokenEconomy, patterns, workflowFitness, systemPrompt, kpis } = findings
  const lines: string[] = [
    'PRE-COMPUTED MECHANICAL ANALYSIS (authoritative — cite these, do not re-count):',
    '',
    '=== Token Economy ===',
    `Total estimated waste: ~${tokenEconomy.totalEstimatedWaste} tokens`,
    `Failed tool calls: ${tokenEconomy.failedToolCalls.count}`,
    `Edit-revert churn: ${tokenEconomy.editRevertChurn.pairCount} pairs`,
    `Repeated reads: ${tokenEconomy.repeatedReads.length} files`,
  ]

  if (tokenEconomy.repeatedReads.length > 0) {
    lines.push(
      'Top repeated reads:',
      ...tokenEconomy.repeatedReads
        .slice(0, 5)
        .map((r) => `  ${r.path}: ${r.count}× excess (~${r.estimatedWastedTokens} tokens)`),
    )
  }

  lines.push(
    '',
    '=== Pattern Adoption ===',
    `Codegraph: ${patterns.codegraphAdoption.used} calls (${patterns.codegraphAdoption.ratio.toFixed(2)} of exploration)`,
    `RTK: ${patterns.rtkAdoption.rtkCommands} rtk vs ${patterns.rtkAdoption.rawCommands} raw commands`,
    `Agent delegation: ${patterns.agentDelegation.agentCalls} calls`,
  )

  if (patterns.opportunities.length > 0) {
    lines.push('Opportunities:', ...patterns.opportunities.map((o) => `  - ${o.suggestion}`))
  }

  lines.push(
    '',
    '=== Workflow Fitness ===',
    `Verify step present: ${workflowFitness.verifyStepPresent}`,
    `Verify outcome: ${workflowFitness.verifyOutcome ?? 'n/a'}`,
    `Max concurrent agents: ${workflowFitness.concurrency.maxConcurrent}`,
    `Duration anomalies: ${workflowFitness.durationAnomalies.length}`,
    '',
    '=== System Prompt ===',
    `System prompt: ~${systemPrompt.totalSystemPromptTokens} tokens`,
    `Task prompt: ~${systemPrompt.taskPromptTokens} tokens`,
    `System/task ratio: ${systemPrompt.systemToTaskRatio.toFixed(1)}×`,
    `Sections detected: ${systemPrompt.sections.length}`,
    '',
    '=== KPIs ===',
    `Total weighted tokens: ${kpis.arcTotals.weightedTokens}`,
    `Total turns: ${kpis.arcTotals.turnCount}`,
    `Tokens/turn: ${kpis.arcTotals.tokensPerTurn}`,
    `Cache hit ratio: ${kpis.arcTotals.cacheHitRatio.toFixed(2)}`,
    `Too-large signals: ${kpis.tooLargeSignals.length}`,
  )

  if (kpis.slicingDiagnosis) lines.push(`Slicing diagnosis: ${kpis.slicingDiagnosis}`)

  lines.push(
    '',
    'Incorporate the above pre-computed findings into your analysis. They are authoritative mechanical data.',
    '',
  )

  return lines.join('\n')
}

// ─── Step summaries (rendered in the CLI and the UI step cards) ─────────────

const tokenEconomySummary = (f: TokenEconomyFindings): string => {
  const parts: string[] = []
  if (f.repeatedReads.length > 0) parts.push(`${f.repeatedReads.length} repeated reads`)
  if (f.failedToolCalls.count > 0) parts.push(`${f.failedToolCalls.count} failed calls`)
  if (f.editRevertChurn.pairCount > 0) {
    parts.push(`${f.editRevertChurn.pairCount} edit-revert pairs`)
  }
  parts.push(`~${f.totalEstimatedWaste} tokens wasted`)
  return parts.join(', ')
}

const patternsSummary = (f: PatternFindings): string => {
  const pct = (f.codegraphAdoption.ratio * 100).toFixed(0)
  const parts = [
    `codegraph ${f.codegraphAdoption.ratio < CODEGRAPH_ADOPTION_FLOOR ? 'underused' : 'ok'} (${pct}%)`,
  ]
  if (f.rtkAdoption.rawCommands > 0 && f.rtkAdoption.rtkCommands === 0) parts.push('rtk unused')
  if (f.opportunities.length > 0) parts.push(`${f.opportunities.length} opportunities`)
  return parts.join(', ')
}

const fitnessSummary = (f: WorkflowFitnessFindings): string => {
  const parts = [
    `verify=${f.verifyOutcome ?? 'none'}`,
    `${f.concurrency.maxConcurrent} max concurrent`,
  ]
  if (f.durationAnomalies.length > 0) {
    parts.push(`${f.durationAnomalies.length} duration anomalies`)
  }
  return parts.join(', ')
}

const systemPromptSummary = (f: SystemPromptFindings): string =>
  `~${f.totalSystemPromptTokens} sys tokens, ${f.systemToTaskRatio.toFixed(1)}× task ratio, ${f.sections.length} sections`

const kpisSummary = (f: KpiFindings): string => {
  const parts = [
    `${f.arcTotals.weightedTokens} weighted tokens`,
    `${f.arcTotals.turnCount} turns`,
  ]
  if (f.tooLargeSignals.length > 0) parts.push(`${f.tooLargeSignals.length} too-large signals`)
  if (f.slicingDiagnosis) parts.push('slicing issue detected')
  return parts.join(', ')
}

// ─── Workflow definition ────────────────────────────────────────────────────

const reflectInputSchema = z.object({
  originId: z.string(),
})

type ReflectInput = z.infer<typeof reflectInputSchema>

export interface ReflectServices {
  traceStore: TraceEventStore
}

const emptyReport = (): DeepReflectionReport => ({
  summary: '',
  toolCallStats: { total: 0, byName: {} },
  dissonantCalls: [],
  verifyMismatch: null,
  verifyMismatches: [],
  thrashingPatterns: [],
  rootCause: '',
  suggestions: [],
  scorerSuggestions: [],
  capabilityGapSuggestions: [],
})

/**
 * The reflect pipeline: five mechanical analysis steps feeding one LLM
 * synthesis step.
 *
 * Every step is wrapped twice on purpose. `ctx.step` gives the workflow engine
 * checkpoint-resume and a `workflow_step_runs` record; `runNonLlmStepWithSpan`
 * writes the paired `step_started`/`step_ended` trace events that the UI's
 * step-card list reads. Without the inner wrap the steps run fine but stay
 * invisible in `mars ui`.
 */
export const reflectWorkflow = defineWorkflow<ReflectInput, ReflectOutput, ReflectServices>({
  id: 'reflect',
  inputSchema: reflectInputSchema,
  fn: async (ctx, input) => {
    const { traceStore } = ctx.services

    /**
     * Run one step under three recording surfaces at once: the engine step
     * record, the trace span, and a `reflect.step-result` emit.
     *
     * The emit is load-bearing for progress: the engine calls `onEvent` only
     * for `step.skipped` — `step.started`/`step.completed` go to its logger and
     * never reach a subscriber — so `ctx.emit` is the only way a caller sees a
     * step land in real time. The payload stays small (name + summary); the
     * full findings live on the step record's `resultJson`.
     */
    const step = <T>(
      name: string,
      fn: () => Promise<T> | T,
      summarize: (result: T) => string,
    ): Promise<T> =>
      ctx.step(name, () => {
        // Captured by getExtraPayload after fn() resolves so the summary
        // lands in the step_ended trace-event payload (→ UI step card).
        let stepSummary = ''
        return runNonLlmStepWithSpan({
          stepName: name,
          workflowInstanceId: ctx.runId,
          originId: input.originId,
          // Attribute the span to the origin task, not null. The UI's task
          // drawer and run timeline both filter on `task_id`, and a NULL never
          // matches an equality filter — a null here makes the whole reflect
          // run invisible in `mars ui`. Carrying both ids satisfies the
          // originId-filtered proposal view too.
          taskId: input.originId,
          // TODO(trace-events-store): 'reflect' is not yet in the
          // TraceEventPhase union / TRACE_EVENT_PHASES list — reads coerce it
          // to null until the union gains 'reflect'. The cast preserves the
          // stored value (and today's runtime behavior) in the meantime.
          phase: 'reflect' as TraceEventPhase,
          traceStore,
          fn: async () => {
            const result = await fn()
            const summary = summarize(result)
            stepSummary = summary
            ctx.currentStep?.setSummary(summary)
            ctx.emit('reflect.step-result', { step: name, summary })
            return result
          },
          getExtraPayload: () => ({ summary: stepSummary }),
        })
      })

    // Loading is cheap and deterministic, so it sits outside the step contract:
    // on resume we want the arc in hand before any step short-circuits.
    const arc = await loadDeepReflectArc(input.originId)
    if (!arc) throw new Error(`no arc found for ${input.originId}`)
    const digest = digestArc(arc.tasks)

    await step(
      'load-arc',
      () => ({
        taskCount: arc.taskCount,
        statusMix: arc.statusMix,
        eventCount: arc.totals.eventCount,
        weightedTokens: Math.round(arc.totals.totalWeightedTokens),
      }),
      (r) =>
        `${r.taskCount} task(s), ${r.eventCount} events, ${r.weightedTokens} weighted tokens`,
    )

    const tokenEconomy = await step(
      'analyze-token-economy',
      () => analyzeTokenEconomy(digest),
      tokenEconomySummary,
    )

    const patterns = await step(
      'analyze-patterns',
      () => analyzePatterns(arc, digest),
      patternsSummary,
    )

    const workflowFitness = await step(
      'analyze-workflow-fitness',
      () => analyzeWorkflowFitness(arc),
      fitnessSummary,
    )

    const systemPrompt = await step(
      'analyze-system-prompt',
      () => analyzeSystemPrompt(arc),
      systemPromptSummary,
    )

    const kpis = await step('compute-kpis', () => computeKpis(arc, digest), kpisSummary)

    const stepFindings: ReflectStepFindings = {
      tokenEconomy,
      patterns,
      workflowFitness,
      systemPrompt,
      kpis,
    }

    const synthesis = await step(
      'synthesize',
      async () => {
        const prompt = `${buildFindingsPreamble(stepFindings)}${buildArcPrompt(arc)}`
        const model = process.env.MARS_DEEP_REFLECT_MODEL ?? 'opus'
        const timeoutMs =
          Number(process.env.MARS_DEEP_REFLECT_TIMEOUT_MS) || 10 * 60 * 1000

        const r = await runClaudeCode({ cwd: getRepoRoot(), prompt, timeoutMs, model })
        const text = collectAssistantText(r.conversation) || r.stdout
        const report = parseDeepReflectionReport(text)

        // Persist save-verdict suggestions as domain-scoped memory packets, on
        // the same terms as the legacy path: only on a clean, parseable run.
        if (process.env.MARS_REFLECT_DISABLED !== '1' && r.exitCode === 0 && report !== null) {
          const domain = await resolveArcDomain(arc.originId)
          for (const suggestion of report.suggestions) {
            if (suggestion.verdict !== 'save') continue
            await insertMemoryPacket({
              domain,
              text: suggestion.prompt,
              salience: suggestion.confidence ?? 0.7,
              originArcId: arc.originId,
            })
          }
        }

        return { report: report ?? emptyReport(), rawOutput: text, exitCode: r.exitCode }
      },
      ({ report }) => {
        const count = (v: string): number =>
          report.suggestions.filter((s) => s.verdict === v).length
        return `${report.suggestions.length} suggestions (${count('save')} save, ${count('absorb')} absorb, ${count('drop')} drop)`
      },
    )

    return {
      report: synthesis.report,
      stepFindings,
      rawOutput: synthesis.rawOutput,
      exitCode: synthesis.exitCode,
    }
  },
})

export const runReflect = async (
  originId: string,
  opts?: {
    onEvent?: (event: WorkflowEvent) => void
    traceStore?: TraceEventStore
  },
): Promise<ReflectOutput> => {
  const result = await runWorkflow(
    reflectWorkflow,
    { originId },
    {
      store: createQueueWorkflowStore(),
      services: { traceStore: opts?.traceStore ?? nullTraceStore },
      onEvent: opts?.onEvent,
    },
  )
  if (result.status !== 'completed' || !result.output) {
    const cause = result.error instanceof Error ? `: ${result.error.message}` : ''
    // Preserve the original error as `cause` — the step that threw is the only
    // thing that makes a failed reflect run diagnosable.
    throw new Error(`reflect workflow ${result.status}${cause}`, { cause: result.error })
  }
  return result.output
}
