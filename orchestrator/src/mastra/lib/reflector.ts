import { runClaudeCode } from './git'
import { getRepoRoot } from '../context'
import { createProposal } from '../proposals'
import type { ReflectCorpus } from './reflect-query'

export interface ReflectionSuggestion {
  title: string
  prompt: string
  rationale: string | null
}

export interface CostAnalysis {
  headline: string
  expensiveTasks: ReadonlyArray<{
    taskId: string
    costUsd: number
    multipleOfMedian: number
    rootCause: string
  }>
  expensiveSteps: ReadonlyArray<{
    stepId: string
    totalCostUsd: number
    verdict: string
    evidence: string
  }>
  cacheHealth: { ratio: number; verdict: string; evidence: string } | null
  successVsFailureSpend: { successUsd: number; failureUsd: number; verdict: string } | null
  notes: string
}

export interface ReflectionResult {
  costAnalysis: CostAnalysis | null
  suggestions: ReflectionSuggestion[]
  rawOutput: string
  exitCode: number
}

const SYNTHESIS_INSTRUCTIONS = `You are a workflow + cost optimizer for the Mars task orchestrator. You
will be given a precomputed cost summary and a recent task corpus
(prompts, final status, scorer scores, per-step token + cost totals,
error tails).

Your output has TWO sections:

1. costAnalysis: a structured analysis of recent spend.
2. suggestions: actionable Mars task drafts grounded in that analysis.

For costAnalysis, ground every observation in the numbers from the
provided costSummary. Specifically:
- Identify any task whose cost is ≥ 2× the median cost per task. Cite
  the task id, the multiple, and what made it expensive (which step,
  which signal).
- Identify the top 1–2 most expensive *steps* (not tasks). For each,
  state whether the spend is justified by outcome (success rate,
  scorer score) or wasted (failed verify / merge aborts).
- Comment on cache health: if cacheHitRatio < 0.5, that is a red flag
  (we are paying to re-warm caches). Cite the ratio.
- Compare avgCostPerSuccess vs avgCostPerFailure. If failures cost
  ≥ 70% of a success, the loop is leaking money on dead ends.

For each suggestion, prefer cost-grounded ones over generic cleanups.
Categories, in priority order:
(a) **cost sinks**: a specific step or task pattern that is burning
    tokens relative to its value. Cite token counts.
(b) **failure clusters**: tasks sharing a verify-failed root cause
    (typecheck vs test vs lint) or repeated merge aborts. Quantify the
    wasted spend in tokens (sum of failed-task token totals).
(c) **cache-miss patterns**: cache_create_tokens >> cache_read_tokens
    on a hot step.
(d) **workflow drift**: repeated vcs-supervisor invocations, prompt
    patterns that consistently fail.

If total token spend across the window is non-trivial, you MUST produce
at least one cost-grounded suggestion. If a single task is > 3× the
median token spend, you MUST either suggest investigating it or
explicitly justify ignoring it in costAnalysis.notes.

Output a single JSON document on stdout, with no prose, no code fences,
no markdown — just the JSON. Shape:

{
  "costAnalysis": {
    "headline": "1-sentence summary of the spend health",
    "expensiveTasks": [
      { "taskId": "abcd1234", "costUsd": 0.42, "multipleOfMedian": 3.1, "rootCause": "..." }
    ],
    "expensiveSteps": [
      { "stepId": "code", "totalCostUsd": 1.20, "verdict": "justified|wasted", "evidence": "..." }
    ],
    "cacheHealth": { "ratio": 0.34, "verdict": "healthy|degraded|broken", "evidence": "..." },
    "successVsFailureSpend": { "successUsd": 0.12, "failureUsd": 0.30, "verdict": "..." },
    "notes": "anything else, or empty string"
  },
  "suggestions": [
    {
      "title": "short imperative title (≤ 60 chars)",
      "category": "cost|failure|cache|drift",
      "prompt": "self-contained Mars task prompt that a fresh agent can act on without further context. Include file paths, the symptom, the suggested fix, and the verification command. End with 'Save your work.'",
      "rationale": "1–2 sentences citing the evidence: task ids, token counts, error patterns"
    }
  ]
}

Rules:
- At most 5 suggestions. Fewer is better.
- Each suggestion must be actionable today, not aspirational.
- Drop suggestions you cannot ground in the data.
- If there are no high-quality suggestions, return {"suggestions": []}
  but still fill costAnalysis.`

export const buildPrompt = (corpus: ReflectCorpus): string => {
  const summaryJson = JSON.stringify(corpus.costSummary, null, 2)
  const entriesJson = JSON.stringify(corpus.entries, null, 2)
  return `${SYNTHESIS_INSTRUCTIONS}

Cost summary (precomputed — trust these numbers, do not recompute):
${summaryJson}

Recent task corpus (newest first):
${entriesJson}`
}

interface ParsedDocument {
  suggestions?: unknown
  costAnalysis?: unknown
}

const parseCostAnalysis = (raw: unknown): CostAnalysis | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const expensiveTasks = asArray(o.expensiveTasks)
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const r = t as Record<string, unknown>
      return {
        taskId: typeof r.taskId === 'string' ? r.taskId : '',
        costUsd: typeof r.costUsd === 'number' ? r.costUsd : 0,
        multipleOfMedian: typeof r.multipleOfMedian === 'number' ? r.multipleOfMedian : 0,
        rootCause: typeof r.rootCause === 'string' ? r.rootCause : '',
      }
    })
    .filter((t) => t.taskId)
  const expensiveSteps = asArray(o.expensiveSteps)
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const r = s as Record<string, unknown>
      return {
        stepId: typeof r.stepId === 'string' ? r.stepId : '',
        totalCostUsd: typeof r.totalCostUsd === 'number' ? r.totalCostUsd : 0,
        verdict: typeof r.verdict === 'string' ? r.verdict : '',
        evidence: typeof r.evidence === 'string' ? r.evidence : '',
      }
    })
    .filter((s) => s.stepId)
  const cacheHealthRaw = o.cacheHealth as Record<string, unknown> | null | undefined
  const cacheHealth =
    cacheHealthRaw && typeof cacheHealthRaw === 'object'
      ? {
          ratio: typeof cacheHealthRaw.ratio === 'number' ? cacheHealthRaw.ratio : 0,
          verdict:
            typeof cacheHealthRaw.verdict === 'string' ? cacheHealthRaw.verdict : '',
          evidence:
            typeof cacheHealthRaw.evidence === 'string' ? cacheHealthRaw.evidence : '',
        }
      : null
  const svfRaw = o.successVsFailureSpend as Record<string, unknown> | null | undefined
  const successVsFailureSpend =
    svfRaw && typeof svfRaw === 'object'
      ? {
          successUsd: typeof svfRaw.successUsd === 'number' ? svfRaw.successUsd : 0,
          failureUsd: typeof svfRaw.failureUsd === 'number' ? svfRaw.failureUsd : 0,
          verdict: typeof svfRaw.verdict === 'string' ? svfRaw.verdict : '',
        }
      : null
  return {
    headline: typeof o.headline === 'string' ? o.headline : '',
    expensiveTasks,
    expensiveSteps,
    cacheHealth,
    successVsFailureSpend,
    notes: typeof o.notes === 'string' ? o.notes : '',
  }
}

export const extractFirstJsonDocument = (text: string): unknown | null => {
  const trimmed = text.trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1)
        try {
          return JSON.parse(candidate)
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export const collectAssistantText = (
  conversation: ReadonlyArray<{ type: string; [k: string]: unknown }>,
): string => {
  const parts: string[] = []
  for (const event of conversation) {
    if (event.type !== 'assistant') continue
    const message = event.message as { content?: unknown } | undefined
    if (!message) continue
    const content = message.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          parts.push((block as { text: string }).text)
        }
      }
    }
  }
  return parts.join('\n')
}

export const runReflector = async (
  corpus: ReflectCorpus,
  timeoutMs: number = 180 * 1000,
): Promise<ReflectionResult> => {
  if (corpus.entries.length === 0) {
    return { costAnalysis: null, suggestions: [], rawOutput: '', exitCode: 0 }
  }

  const r = await runClaudeCode({
    cwd: getRepoRoot(),
    prompt: buildPrompt(corpus),
    timeoutMs,
    model: 'sonnet',
  })

  const text = collectAssistantText(r.conversation) || r.stdout
  const parsed = extractFirstJsonDocument(text) as ParsedDocument | null
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    return {
      costAnalysis: parseCostAnalysis(parsed?.costAnalysis),
      suggestions: [],
      rawOutput: text,
      exitCode: r.exitCode,
    }
  }
  const costAnalysis = parseCostAnalysis(parsed.costAnalysis)

  const suggestions: ReflectionSuggestion[] = []
  for (const raw of parsed.suggestions) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const title = typeof obj.title === 'string' ? obj.title.trim() : ''
    const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : ''
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : null
    if (!title || !prompt) continue
    suggestions.push({ title, prompt, rationale: rationale || null })
  }

  return {
    costAnalysis,
    suggestions: suggestions.slice(0, 5),
    rawOutput: text,
    exitCode: r.exitCode,
  }
}

export const persistSuggestions = async (
  suggestions: readonly ReflectionSuggestion[],
  _sourceTaskId: string,
): Promise<void> => {
  for (const s of suggestions) {
    await createProposal(s.title, {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
      solution: s.prompt,
      notes: s.rationale ?? '',
    })
  }
}

export type SuggestionVerdict = 'save' | 'absorb' | 'drop'

export interface VerdictedSuggestion {
  title: string
  prompt: string
  rationale: string | null
  verdict: SuggestionVerdict
  targetId?: string | null
  dupOf?: string | null
}

export interface ApplyVerdictsResult {
  saved: number
  absorbed: number
  dropped: number
  savedSuggestions: VerdictedSuggestion[]
}

export const parseVerdict = (raw: unknown): SuggestionVerdict => {
  if (raw === 'absorb' || raw === 'drop' || raw === 'save') return raw
  return 'save'
}

export const applyVerdicts = async (
  suggestions: readonly VerdictedSuggestion[],
  _sourceTaskId: string,
): Promise<ApplyVerdictsResult> => {
  let saved = 0
  let absorbed = 0
  let dropped = 0
  const savedSuggestions: VerdictedSuggestion[] = []
  for (const s of suggestions) {
    if (s.verdict === 'drop') {
      dropped += 1
      continue
    }
    if (s.verdict === 'absorb') {
      // 'absorb' means the finding was folded into an existing idea or
      // task and does not warrant a new row. Counted but not persisted.
      absorbed += 1
      continue
    }
    await createProposal(s.title, {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
      solution: s.prompt,
      notes: s.rationale ?? '',
    })
    saved += 1
    savedSuggestions.push(s)
  }
  return { saved, absorbed, dropped, savedSuggestions }
}
