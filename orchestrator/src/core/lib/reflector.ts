import { runHeadlessProvider } from '../workers/providers'
import { getRepoRoot } from '../context'
import { createHash } from 'node:crypto'
import {
  createProposal,
  findOpenReflectionDraftByFingerprint,
  appendProposalNotes,
} from '../proposals'
import { enqueueTask } from '../queue'
import type { ReflectCorpus } from './reflect-query'
import type { SelfEvolveConfig } from '../daemon/config'
import { isReflectDisabled } from './reflect-signals'
import { isAutoReflectDisabled } from './auto-reflect-gate'
import { insertMemoryPacket } from '../store/memory-packet-store'
import { loadLeverRegistry, formatRecipeCatalog } from './lever-registry'

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
  /**
   * Model-assessed confidence (0..1) grounded in frequency, token deltas, and
   * reproducibility. Used to gate auto-enqueuing: only suggestions with
   * confidence >= selfEvolve.taskConfidenceThreshold and kind='mechanical' are
   * auto-enqueued when autoTrigger is enabled.
   */
  confidence: number
  /**
   * Routing kind:
   * - 'mechanical': a config/prompt/threshold change with a clear verification
   *   step that a fresh agent can execute and confirm.
   * - 'architectural': changes seams, data shapes, or policy — requires human
   *   review and is never auto-enqueued regardless of confidence.
   */
  kind: 'mechanical' | 'architectural'
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
(prompts, final status, per-step token totals, error tails).

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
  state whether the spend is justified by outcome (success rate) or
  wasted (failed verify / merge aborts).
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

For each suggestion you MUST also assess:

**confidence** (0..1): Your evidence-grounded certainty that acting on
this suggestion will reduce token waste or failure rate. Ground it in:
- frequency: how many tasks were affected (more = higher confidence)
- token delta: how large the waste is relative to the median
- reproducibility: whether the pattern is consistent or a one-off
Do NOT inflate confidence. A single data point with no clear cause
should be ≤ 0.5. A pattern across 3+ tasks with a clear mechanical fix
can reach 0.8–0.95.

**kind**: Classify the suggestion as exactly one of:
- 'mechanical': the fix is a config/prompt/threshold change with a
  clear, agent-executable verification step (e.g. add --strict to
  tsconfig, lower a token cap, tighten a prompt heuristic). The scope
  is narrow and reversible.
- 'architectural': the fix changes seams, data shapes, service
  boundaries, or policy (e.g. split a module, introduce a new DB table,
  change auth flow, alter task-graph semantics). These require human
  review and are NEVER auto-applied by the orchestrator regardless of
  confidence. When in doubt between mechanical and architectural, choose
  architectural.

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
      "frequency": 2,
      "confidence": 0.85,
      "kind": "mechanical"
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
- \`confidence\` must be grounded in frequency, token deltas, and
  reproducibility — do not inflate it. A single-task observation with no
  clear cause should be ≤ 0.5.
- \`kind\` must be 'mechanical' or 'architectural' exactly (lowercase). When
  in doubt, choose 'architectural'.
- If there are no high-quality suggestions, return {"suggestions": []}
  but still fill tokenAnalysis.

ENVIRONMENTAL vs BEHAVIORAL: When failures are attributable to the
environment — provider quota/429 rejections (see rateLimitRejections in
the cost summary), dependency install errors (pnpm/npm exit codes), daemon
restarts, or watchdog kills — classify the finding as an infrastructure
finding and route it to orchestrator code/config fixes. NEVER count these
failures against a task pattern's confidence, and NEVER classify them as
coder-prompt problems. A task that failed because the provider returned a
rate-limit rejection is not evidence that the coder prompt needs work.

FIRST TOOL CALL: When a corpus entry has toolErrorCount > 0 and the very
first tool_invoked trace event for that task is an error (indicated by
topErrorTool being set with a high error count relative to total tool
calls), this is a strong signal of a prompt/environment defect — missing
orientation, wrong working directory, absent expected file. Call this out
explicitly in tokenAnalysis.notes, naming the topErrorTool and the task ID.

KPI FRAMING: Every suggestion in the \`prompt\` field MUST state its
expected effect on the two orchestrator KPIs — task completeness (the
fraction of tasks reaching 'done') and token cost (total weighted tokens
per window). Example: "Expected effect: raises completeness by eliminating
setup-phase failures; saves ~N weighted tokens per affected task by
avoiding retry cycles." Do not emit a suggestion prompt that omits both
KPI impacts.

3. harnessMaturity: assess the current verify-gate configuration.
   - Count tasks that ran with zero verify gates (look for the
     "no-gates-configured" step name in gate outcomes / verify output).
   - If > 50% of tasks have no gates, this is a high-priority suggestion.
   - Check if any recurring failure signature maps to a missing gate
     (e.g. typecheck failures in a repo with no typecheck gate).
   - For each applicable improvement recipe, state whether it should
     be suggested and include the concrete \`mars verify add ...\` command.

   Include harness maturity suggestions in your suggestions[] array with
   kind: 'mechanical' and high confidence (0.9+) when gates are clearly
   missing.

The improvement recipe catalog provided below lists available recipes with
their trigger patterns and setup steps. Reference these recipes when
assessing harness maturity and constructing the \`mars verify add ...\`
commands for any applicable suggestions.`

const CHAT_FEEDBACK_INSTRUCTIONS = `

--- Chat Feedback (operator-rated exchanges) ---

The operator has rated the following chat replies. When thumbs-down entries
are present, propose targeted edits to the chat system prompt that address
the specific behaviour rated negatively. Each chat-feedback suggestion must:

- Name the concrete behaviour that was rated down (e.g. "replied with a
  wall of prose when a single-line answer was expected").
- Propose concrete replacement or additional wording for the chat system
  prompt — quote the suggested text.
- NOT propose vague changes like "be more concise" without specifying what
  the prompt text should say instead.

Use category "chat" for these suggestions. The \`prompt\` field should
describe what to change in .mars/chat-system-prompt.md and include the
suggested wording so the operator can apply it directly with a text editor.
End the prompt with "Save your work."

Current chat system prompt:
<CURRENT_SYSTEM_PROMPT>

Rated exchanges (newest first):
<EXCHANGES>
--- End Chat Feedback ---`

const formatChatFeedbackSection = (
  chatFeedback: readonly import('./chat-feedback-query').ChatFeedbackEntry[],
  chatSystemPrompt: string,
): string => {
  const exchanges = chatFeedback
    .map((e) => {
      const lines: string[] = [
        `[${e.rating.toUpperCase()}] ${new Date(e.createdAt).toISOString().slice(0, 10)} | thread:${e.threadId.slice(0, 8)} | note:${e.note ?? '(none)'}`,
        `  user: ${e.userPrompt || '(no preceding user message)'}`,
        `  assistant: ${e.assistantReply}`,
      ]
      if (e.toolsUsed.length > 0) {
        lines.push(`  tools: ${e.toolsUsed.join(', ')}`)
      }
      return lines.join('\n')
    })
    .join('\n\n')

  return CHAT_FEEDBACK_INSTRUCTIONS
    .replace('<CURRENT_SYSTEM_PROMPT>', chatSystemPrompt)
    .replace('<EXCHANGES>', exchanges)
}

export const buildPrompt = (corpus: ReflectCorpus): string => {
  const summaryJson = JSON.stringify(corpus.costSummary, null, 2)
  const entriesJson = JSON.stringify(corpus.entries, null, 2)
  const recipeCatalog = formatRecipeCatalog(loadLeverRegistry())

  const base = `${SYNTHESIS_INSTRUCTIONS}

Improvement recipe catalog (use these for harness maturity suggestions):
${recipeCatalog}

Token summary (precomputed — trust these numbers, do not recompute):
${summaryJson}

Recent task corpus (newest first):
${entriesJson}`

  const feedback = corpus.chatFeedback
  if (!feedback || feedback.length === 0) {
    return base
  }

  const systemPrompt = corpus.chatSystemPrompt ?? ''
  return `${base}${formatChatFeedbackSection(feedback, systemPrompt)}`
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
  const r = await runHeadlessProvider(buildPrompt(corpus), {
    cwd: getRepoRoot(),
    modelTier: 'balanced',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
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
    const rawConfidence = obj.confidence
    const confidence =
      typeof rawConfidence === 'number' &&
      Number.isFinite(rawConfidence) &&
      rawConfidence >= 0 &&
      rawConfidence <= 1
        ? rawConfidence
        : 0
    const rawKind = obj.kind
    const kind: 'mechanical' | 'architectural' =
      rawKind === 'mechanical' || rawKind === 'architectural' ? rawKind : 'mechanical'
    if (!title || !prompt) continue
    suggestions.push({
      title,
      prompt,
      rationale: rationale || null,
      rootCauseKey,
      affectedTaskIds,
      frequency,
      confidence,
      kind,
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
  selfEvolve?: Pick<SelfEvolveConfig, 'autoTrigger' | 'taskConfidenceThreshold'>,
): Promise<void> => {
  for (const s of suggestions) {
    if (
      selfEvolve?.autoTrigger === true &&
      s.kind === 'mechanical' &&
      s.confidence >= (selfEvolve.taskConfidenceThreshold ?? 0.8)
    ) {
      await enqueueTask(s.prompt, undefined, {
        author: { kind: 'agent', name: 'reflector' },
        spec: {
          files: [],
          verifyCmd: null,
          doneCriteria: [s.title],
          mergeMode: 'auto',
        },
      })
    } else {
      await persistOneSuggestion(s)
    }
    if (!isAutoReflectDisabled() && !isReflectDisabled()) {
      await insertMemoryPacket({
        domain: 'general',
        text: s.prompt,
        salience: s.confidence || 0.7,
        originArcId: null,
      })
    }
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
  confidence: number
  kind: 'mechanical' | 'architectural'
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

/**
 * A scorer suggestion emitted by the deep-reflector analyst: a per-Workflow
 * quality rubric for a measurement gap the pipeline's verify gate cannot see
 * (PRD 6988ed3b). Passes through the same save/absorb/drop verdicting as
 * {@link VerdictedSuggestion} so the analyst contract stays uniform.
 */
export interface VerdictedScorerSuggestion {
  /** Target Workflow kind (matches the arc tasks' workflow kind, e.g. 'task', 'fix'). */
  workflow: string
  /** Short human label for the quality dimension graded. */
  title: string
  /** Self-contained scoring prompt — no arc-specific references. */
  rubric: string
  /** Analyst confidence in 0..1. */
  confidence: number
  /** Concrete evidence (dissonant calls / verify mismatches) motivating the gap. */
  evidence: string[]
  verdict: SuggestionVerdict
}

export interface ApplyScorerVerdictsResult {
  /** Fresh `scorers` rows landed with status='suggested'. */
  suggested: number
  /** Findings folded into an existing suggested scorer (fingerprint match) — no new row. */
  absorbed: number
  /** Discarded findings (verdict 'drop', or the dimension was already triaged). */
  dropped: number
  /** Ids of the freshly suggested scorer rows. */
  suggestedScorerIds: string[]
}

/**
 * A capability-gap suggestion emitted by the deep-reflector analyst: a step
 * self-reported that it lacked a tool or capability needed to do its job.
 * Surfaces the gap as a proposal for a human to act on — the framework never
 * auto-installs or auto-configures anything in response.
 */
export interface VerdictedCapabilityGapSuggestion {
  /** The pipeline step that reported the gap (e.g. 'behaviour-verify'). */
  stepName: string
  /** Short label for the missing capability (e.g. 'browser/UI-driving MCP tool'). */
  capability: string
  /** What the step could not do, and what wiring the capability would unlock. */
  description: string
  /** Concrete evidence (quoted excerpts from the step trace) motivating the finding. */
  evidence: string[]
  verdict: SuggestionVerdict
}

export interface ApplyCapabilityGapVerdictsResult {
  /** Fresh draft proposals landed for a not-yet-reported capability gap. */
  saved: number
  /** Findings folded into an existing open draft for the same gap — no new row. */
  absorbed: number
  /** Discarded ('drop' verdict). */
  dropped: number
  /** Ids of the proposals created by this call. */
  proposalIds: string[]
}

/**
 * Stable fingerprint for a capability gap: one open draft per
 * (step, capability) pair, however many arcs report it.
 */
const capabilityGapFingerprint = (stepName: string, capability: string): string =>
  createHash('sha256')
    .update(`capability-gap:${stepName}:${capability}`)
    .digest('hex')
    .slice(0, 32)

/**
 * Apply save/absorb/drop verdicts to capability-gap suggestions — the third
 * reflection output type, landed on the SAME surface as {@link applyVerdicts}:
 * a draft proposal. That is what puts the gap in `mars proposal list` and in
 * the action queue's `draft-proposal` rows, so an operator actually sees it.
 *
 * The framework never auto-installs or auto-configures the missing capability;
 * the proposal is a request for a human decision, by design.
 *
 * - 'save'   → create a draft proposal, or append evidence to the open draft
 *              already reporting the same (step, capability) pair.
 * - 'absorb' → append evidence to the existing draft when one exists; never
 *              creates a row. Counted as absorbed either way, mirroring
 *              {@link applyVerdicts} semantics.
 * - 'drop'   → discarded.
 */
export const applyCapabilityGapVerdicts = async (
  suggestions: readonly VerdictedCapabilityGapSuggestion[],
  provenance: { originArcId: string },
): Promise<ApplyCapabilityGapVerdictsResult> => {
  let saved = 0
  let absorbed = 0
  let dropped = 0
  const proposalIds: string[] = []

  for (const s of suggestions) {
    if (s.verdict === 'drop') {
      dropped += 1
      continue
    }

    const fingerprint = capabilityGapFingerprint(s.stepName, s.capability)
    const existing = await findOpenReflectionDraftByFingerprint(fingerprint)
    const evidenceBlock = [
      `Also observed in arc ${provenance.originArcId} (step '${s.stepName}').`,
      ...s.evidence,
    ].join('\n')

    if (existing) {
      await appendProposalNotes(existing.id, evidenceBlock)
      absorbed += 1
      continue
    }
    if (s.verdict === 'absorb') {
      // Nothing to fold into: an 'absorb' verdict never creates a row.
      absorbed += 1
      continue
    }

    const proposal = await createProposal(
      `Capability gap: ${s.capability} (step '${s.stepName}')`,
      {
        source: 'reflection',
        author: { kind: 'agent', name: 'capability-gap' },
        problem:
          s.description ||
          `Step '${s.stepName}' self-reported that it lacked ${s.capability} and could not complete its job.`,
        solution:
          `Decide whether to provision ${s.capability} for the '${s.stepName}' step, and wire it if so. ` +
          `Mars never installs or configures a capability on its own — this proposal exists so the operator can make that call.`,
        notes: [`Reported by arc ${provenance.originArcId}.`, ...s.evidence].join('\n'),
        fingerprint,
      },
    )
    proposalIds.push(proposal.id)
    saved += 1
  }

  return { saved, absorbed, dropped, proposalIds }
}

/**
 * Apply save/absorb/drop verdicts to scorer suggestions — the parallel of
 * {@link applyVerdicts} for the second reflection output type.
 *
 * - 'save'   → `suggestScorer`. The entity-side fingerprint dedup decides the
 *              real outcome: a fresh row counts as suggested, a fold into an
 *              existing suggested row counts as absorbed, and an
 *              already-triaged (accepted/dismissed) dimension counts as
 *              dropped — a duplicate suggestion never reappears in the queue.
 * - 'absorb' → append evidence to the existing suggested scorer matched by
 *              fingerprint (no duplicate rows). Counted as absorbed whether or
 *              not a match existed, mirroring applyVerdicts semantics.
 * - 'drop'   → discarded.
 */
export const applyScorerVerdicts = async (
  suggestions: readonly VerdictedScorerSuggestion[],
  provenance: { originArcId: string; reportPath: string | null },
): Promise<ApplyScorerVerdictsResult> => {
  const { suggestScorer, absorbScorerEvidence } = await import('../scorers')
  let suggested = 0
  let absorbed = 0
  let dropped = 0
  const suggestedScorerIds: string[] = []
  for (const s of suggestions) {
    if (s.verdict === 'drop') {
      dropped += 1
      continue
    }
    if (s.verdict === 'absorb') {
      await absorbScorerEvidence(s.workflow, s.title, s.evidence, s.confidence)
      absorbed += 1
      continue
    }
    const result = await suggestScorer({
      workflow: s.workflow,
      title: s.title,
      rubric: s.rubric,
      originArcId: provenance.originArcId,
      reportPath: provenance.reportPath,
      evidence: s.evidence,
      confidence: s.confidence,
    })
    if (result.outcome === 'created') {
      suggested += 1
      suggestedScorerIds.push(result.scorer.id)
    } else if (result.outcome === 'absorbed') {
      absorbed += 1
    } else {
      dropped += 1
    }
  }
  return { suggested, absorbed, dropped, suggestedScorerIds }
}
