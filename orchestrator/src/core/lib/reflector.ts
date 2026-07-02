import { runClaudeCode } from './git/claude'
import { getRepoRoot } from '../context'
import { createHash } from 'node:crypto'
import {
  createProposal,
  findOpenReflectionDraftByFingerprint,
  appendProposalNotes,
} from '../proposals'
import type { ReflectCorpus } from './reflect-query'

export interface ReflectionSuggestion {
  title: string
  prompt: string
  rationale: string | null
  /** Stable snake_case slug for the root cause (e.g. typecheck_failure). */
  rootCauseKey: string
  /** Task IDs where this root cause was observed. */
  affectedTaskIds: string[]
  /** Number of tasks affected by this root cause. */
  frequency: number
}

export interface TokenAnalysis {
  headline: string
  tokenHeavyTasks: ReadonlyArray<{
    taskId: string
    weightedTokens: number
    multipleOfMedian: number
    rootCause: string
  }>
  tokenHeavySteps: ReadonlyArray<{
    stepId: string
    totalWeightedTokens: number
    verdict: string
    evidence: string
  }>
  cacheHealth: { ratio: number; verdict: string; evidence: string } | null
  successVsFailureTokens: { successTokens: number; failureTokens: number; verdict: string } | null
  notes: string
}

export interface ReflectionResult {
  tokenAnalysis: TokenAnalysis | null
  suggestions: ReflectionSuggestion[]
  rawOutput: string
  exitCode: number
}

const SYNTHESIS_INSTRUCTIONS = `You are a workflow and token optimizer for the Mars task orchestrator. You
will be given a precomputed token summary and a recent task corpus
(prompts, final status, scorer scores, per-step token totals,
error tails).

IMPORTANT: Never emit monetary amounts, dollar figures, or currency symbols.
Cite weighted tokens and multiples-of-median only.

Your output has TWO sections:

1. tokenAnalysis: a structured analysis of recent token spend.
2. suggestions: actionable Mars task drafts grounded in that analysis.

For tokenAnalysis, ground every observation in the numbers from the
provided tokenSummary. Specifically:
- Identify any task whose weighted tokens are ≥ 2× the median weighted
  tokens per task. Cite the task id, the multiple, and what made it
  token-heavy (which step, which signal).
- Identify the top 1–2 most token-heavy *steps* (not tasks). For each,
  state whether the spend is justified by outcome (success rate,
  scorer score) or wasted (failed verify / merge aborts).
- Comment on cache health: if cacheHitRatio < 0.5, that is a red flag
  (we are paying to re-warm caches). Cite the ratio.
- Compare weighted tokens on successful tasks vs failed tasks. If failed
  tasks consume ≥ 70% of a success's tokens, the loop is leaking tokens
  on dead ends.

AGGREGATE BY ROOT CAUSE: emit ONE suggestion per root cause, not per
affected task. If the same root cause (e.g. typecheck failures) is
observed across multiple tasks, emit a SINGLE suggestion that cites all
affected task IDs in \`affectedTaskIds\`. Never emit near-duplicate
suggestions that differ only in which specific task they mention.

FREQUENCY FLOOR: skip a pattern that affects only ONE task unless:
- that task consumed ≥ 2× the window median weighted tokens, OR
- the fix addresses a high-severity issue (correctness, security, or
  data-loss risk).
Single-task observations that don't meet this bar belong in
tokenAnalysis.notes only, not in suggestions.

For each suggestion, prefer token-grounded ones over generic cleanups.
Categories, in priority order:
(a) **token sinks**: a specific step or task pattern that is burning
    tokens relative to its value. Cite weighted token counts.
(b) **failure clusters**: tasks sharing a verify-failed root cause
    (typecheck vs test vs lint) or repeated merge aborts. Quantify the
    wasted spend in tokens (sum of failed-task token totals).
(c) **cache-miss patterns**: cache_create_tokens >> cache_read_tokens
    on a hot step.
(d) **workflow drift**: repeated vcs-supervisor invocations, prompt
    patterns that consistently fail.

If total token spend across the window is non-trivial, you MUST produce
at least one token-grounded suggestion. If a single task is > 3× the
median token spend, you MUST either suggest investigating it or
explicitly justify ignoring it in tokenAnalysis.notes.

Output a single JSON document on stdout, with no prose, no code fences,
no markdown — just the JSON. Shape:

{
  "tokenAnalysis": {
    "headline": "1-sentence summary of token-spend health",
    "tokenHeavyTasks": [
      { "taskId": "abcd1234", "weightedTokens": 42000, "multipleOfMedian": 3.1, "rootCause": "..." }
    ],
    "tokenHeavySteps": [
      { "stepId": "code", "totalWeightedTokens": 120000, "verdict": "justified|wasted", "evidence": "..." }
    ],
    "cacheHealth": { "ratio": 0.34, "verdict": "healthy|degraded|broken", "evidence": "..." },
    "successVsFailureTokens": { "successTokens": 12000, "failureTokens": 30000, "verdict": "..." },
    "notes": "anything else, or empty string"
  },
  "suggestions": [
    {
      "title": "short imperative title (≤ 60 chars)",
      "category": "token|failure|cache|drift",
      "prompt": "self-contained Mars task prompt that a fresh agent can act on without further context. Include file paths, the symptom, the suggested fix, and the verification command. End with 'Save your work.'",
      "rationale": "1–2 sentences citing the evidence: task ids, weighted token counts, error patterns",
      "rootCauseKey": "snake_case_slug stable across runs (e.g. typecheck_failure, cache_miss_code_step)",
      "affectedTaskIds": ["task-id-1", "task-id-2"],
      "frequency": 2
    }
  ]
}

Rules:
- At most 5 suggestions. Fewer is better.
- ONE suggestion per root cause — aggregate, do not duplicate.
- Each suggestion must be actionable today, not aspirational.
- Drop suggestions you cannot ground in the data.
- Keep \`rootCauseKey\` stable: use the same snake_case slug every time you
  observe the same root cause pattern across different runs.
- Do NOT emit dollar amounts, monetary values, or currency symbols — cite
  weighted tokens and multiples-of-median only.
- If there are no high-quality suggestions, return {"suggestions": []}
  but still fill tokenAnalysis.`

export const buildPrompt = (corpus: ReflectCorpus): string => {
  const summaryJson = JSON.stringify(corpus.costSummary, null, 2)
  const entriesJson = JSON.stringify(corpus.entries, null, 2)
  return `${SYNTHESIS_INSTRUCTIONS}

Token summary (precomputed — trust these numbers, do not recompute):
${summaryJson}

Recent task corpus (newest first):
${entriesJson}`
}

interface ParsedDocument {
  suggestions?: unknown
  tokenAnalysis?: unknown
}

const parseTokenAnalysis = (raw: unknown): TokenAnalysis | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const tokenHeavyTasks = asArray(o.tokenHeavyTasks)
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const r = t as Record<string, unknown>
      return {
        taskId: typeof r.taskId === 'string' ? r.taskId : '',
        weightedTokens: typeof r.weightedTokens === 'number' ? r.weightedTokens : 0,
        multipleOfMedian: typeof r.multipleOfMedian === 'number' ? r.multipleOfMedian : 0,
        rootCause: typeof r.rootCause === 'string' ? r.rootCause : '',
      }
    })
    .filter((t) => t.taskId)
  const tokenHeavySteps = asArray(o.tokenHeavySteps)
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const r = s as Record<string, unknown>
      return {
        stepId: typeof r.stepId === 'string' ? r.stepId : '',
        totalWeightedTokens: typeof r.totalWeightedTokens === 'number' ? r.totalWeightedTokens : 0,
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
          verdict: typeof cacheHealthRaw.verdict === 'string' ? cacheHealthRaw.verdict : '',
          evidence: typeof cacheHealthRaw.evidence === 'string' ? cacheHealthRaw.evidence : '',
        }
      : null
  const svfRaw = o.successVsFailureTokens as Record<string, unknown> | null | undefined
  const successVsFailureTokens =
    svfRaw && typeof svfRaw === 'object'
      ? {
          successTokens: typeof svfRaw.successTokens === 'number' ? svfRaw.successTokens : 0,
          failureTokens: typeof svfRaw.failureTokens === 'number' ? svfRaw.failureTokens : 0,
          verdict: typeof svfRaw.verdict === 'string' ? svfRaw.verdict : '',
        }
      : null
  return {
    headline: typeof o.headline === 'string' ? o.headline : '',
    tokenHeavyTasks,
    tokenHeavySteps,
    cacheHealth,
    successVsFailureTokens,
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
): Promise<ReflectionResult> => {
  if (corpus.entries.length === 0) {
    return { tokenAnalysis: null, suggestions: [], rawOutput: '', exitCode: 0 }
  }

  // No wall-clock timeout: reflect synthesis must run to completion.
  // The only way to stop it is Ctrl-C.
  const r = await runClaudeCode({
    cwd: getRepoRoot(),
    prompt: buildPrompt(corpus),
    model: 'sonnet',
  })

  const text = collectAssistantText(r.conversation) || r.stdout
  const parsed = extractFirstJsonDocument(text) as ParsedDocument | null
  if (!parsed || !Array.isArray(parsed.suggestions)) {
    return {
      tokenAnalysis: parseTokenAnalysis(parsed?.tokenAnalysis),
      suggestions: [],
      rawOutput: text,
      exitCode: r.exitCode,
    }
  }
  const tokenAnalysis = parseTokenAnalysis(parsed.tokenAnalysis)

  const suggestions: ReflectionSuggestion[] = []
  for (const raw of parsed.suggestions) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const title = typeof obj.title === 'string' ? obj.title.trim() : ''
    const prompt = typeof obj.prompt === 'string' ? obj.prompt.trim() : ''
    const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : null
    const rootCauseKey =
      typeof obj.rootCauseKey === 'string' ? obj.rootCauseKey.trim() : ''
    const affectedTaskIds = Array.isArray(obj.affectedTaskIds)
      ? (obj.affectedTaskIds as unknown[]).filter(
          (id): id is string => typeof id === 'string',
        )
      : []
    const frequency =
      typeof obj.frequency === 'number'
        ? obj.frequency
        : affectedTaskIds.length || 1
    if (!title || !prompt) continue
    suggestions.push({
      title,
      prompt,
      rationale: rationale || null,
      rootCauseKey,
      affectedTaskIds,
      frequency,
    })
  }

  return {
    tokenAnalysis,
    suggestions: suggestions.slice(0, 5),
    rawOutput: text,
    exitCode: r.exitCode,
  }
}

/**
 * Persist one suggestion as a proposal, deduplicating by root-cause fingerprint.
 *
 * If an open draft already exists with the same fingerprint (source +
 * rootCauseKey), append the new evidence to its notes instead of creating a
 * duplicate proposal. This collapses repeated observations of the same root
 * cause across separate reflection runs into a single actionable draft.
 *
 * Called from both persistSuggestions (token-level reflection) and
 * applyVerdicts (deep-reflection save path), which justifies the extraction.
 */
const persistOneSuggestion = async (s: ReflectionSuggestion): Promise<void> => {
  if (s.rootCauseKey) {
    const fingerprint = createHash('sha256')
      .update(`reflection:${s.rootCauseKey}:`)
      .digest('hex')
      .slice(0, 32)
    const existing = await findOpenReflectionDraftByFingerprint(fingerprint)
    if (existing) {
      const parts: string[] = []
      if (s.affectedTaskIds.length > 0) {
        parts.push(`Also observed in: ${s.affectedTaskIds.join(', ')}`)
      }
      if (s.rationale) parts.push(s.rationale)
      if (parts.length > 0) {
        await appendProposalNotes(existing.id, parts.join('\n'))
      }
      return
    }
    await createProposal(s.title, {
      source: 'reflection',
      author: { kind: 'agent', name: 'reflector' },
      solution: s.prompt,
      notes: s.rationale ?? '',
      fingerprint,
    })
    return
  }
  await createProposal(s.title, {
    source: 'reflection',
    author: { kind: 'agent', name: 'reflector' },
    solution: s.prompt,
    notes: s.rationale ?? '',
  })
}

export const persistSuggestions = async (
  suggestions: readonly ReflectionSuggestion[],
  _sourceTaskId: string,
): Promise<void> => {
  for (const s of suggestions) {
    await persistOneSuggestion(s)
  }
}

export type SuggestionVerdict = 'save' | 'absorb' | 'drop'

export interface VerdictedSuggestion {
  title: string
  prompt: string
  rationale: string | null
  rootCauseKey: string
  affectedTaskIds: string[]
  frequency: number
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
    // Route through the same fingerprint dedup as persistSuggestions so that
    // deep-reflection 'save' verdicts also merge into existing open drafts
    // rather than creating duplicates.
    await persistOneSuggestion(s)
    saved += 1
    savedSuggestions.push(s)
  }
  return { saved, absorbed, dropped, savedSuggestions }
}
