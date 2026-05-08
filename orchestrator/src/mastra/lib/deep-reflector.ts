import { runClaudeCode } from './git'
import { getRepoRoot } from '../context'
import {
  collectAssistantText,
  extractFirstJsonDocument,
  parseVerdict,
  type SuggestionVerdict,
  type VerdictedSuggestion,
} from './reflector'
import type { DeepReflectSession } from './deep-reflect-query'

export interface DissonantCall {
  eventIndex: number
  tool: string
  statedIntent: string
  actualOutcome: string
  severity: 'high' | 'medium' | 'low'
  evidence: string
}

export interface ThrashingPattern {
  pattern: string
  occurrences: number
  evidence: string
}

export interface VerifyMismatch {
  claimed: string
  actual: string
  severity: 'high' | 'medium' | 'low'
}

export interface DeepReflectionReport {
  summary: string
  toolCallStats: { total: number; byName: Record<string, number> }
  dissonantCalls: DissonantCall[]
  verifyMismatch: VerifyMismatch | null
  thrashingPatterns: ThrashingPattern[]
  rootCause: string
  suggestions: VerdictedSuggestion[]
}

export interface DeepReflectionResult {
  report: DeepReflectionReport
  rawOutput: string
  exitCode: number
}

const SYNTHESIS_INSTRUCTIONS = `You are an expert post-mortem analyst for the Mars task orchestrator. You
will be given the FULL claude -p conversation that ran for one Mars task,
plus per-step token+cost signals, scorer scores, and the concatenated
verify-step (typecheck/test/lint) output.

Your job is to walk the conversation event-by-event and surface things
aggregate signal-only reflection cannot see — most importantly, **tool
calls that succeeded but did not achieve the intended outcome**.

Procedure:

1. Walk every event. Build an inventory of tool calls (\`tool_use\` blocks):
   the tool name, a short summary of the input (it may already be truncated
   by claude-stream), and the corresponding \`tool_result\`.

2. Flag **dissonant tool calls** — calls where the result returned success
   but the actual outcome diverges from the assistant's stated goal in the
   surrounding text. Examples to watch for, not exhaustive:
   - \`Edit\` succeeded but the new content does not match the assistant's
     stated intent ("remove the catch block" → catch block still present).
   - \`Bash\` exited 0 but the stdout reveals failure
     (\`git commit\` printing "nothing to commit, working tree clean";
     \`npm test\` printing "0 passed, 0 failed" or "tests skipped";
     \`grep\` printing nothing when the assistant claimed a match).
   - \`Write\` overwrote the wrong file (path differs from the stated target).
   - A merge or supervisor action that "resolved" a conflict by deleting
     both sides.
   For each dissonant call, cite \`eventIndex\` (0-based index into the
   conversation array), the tool name, the stated_intent (a short quote
   from the assistant's text near the call), the actual_outcome (a short
   quote or summary from the tool_result/output), and severity.

3. Cross-reference end-of-turn assistant claims with verifyOutput. If the
   assistant said "all tests pass" but verifyOutput shows a typecheck or
   test failure, record that as verifyMismatch with severity=high.

4. Identify thrashing — same file Read 5+ times, Edit-then-revert pairs on
   the same range, repeated identical Bash invocations.

5. Synthesize a 1–3 sentence rootCause and a small set of actionable
   suggestions (≤5). Each suggestion gets a verdict:
   - "save"   — file as a fresh proposal (default).
   - "absorb" — finding folds into an existing suggestion / task; provide
                target_id when known, else null.
   - "drop"   — cosmetic / not actionable; do not persist.
   Each suggestion's prompt MUST be self-contained and end with
   "Save your work."

Output a SINGLE JSON document on stdout. No prose, no markdown, no fences.

Schema:

{
  "summary": "1-2 sentences on the session outcome",
  "toolCallStats": { "total": N, "byName": { "Edit": N, "Bash": N } },
  "dissonantCalls": [
    {
      "eventIndex": N,
      "tool": "Edit",
      "stated_intent": "...",
      "actual_outcome": "...",
      "severity": "high|medium|low",
      "evidence": "quoted excerpt"
    }
  ],
  "verifyMismatch": {
    "claimed": "...",
    "actual": "...",
    "severity": "high|medium|low"
  },
  "thrashingPatterns": [
    { "pattern": "...", "occurrences": N, "evidence": "..." }
  ],
  "rootCause": "1-3 sentences",
  "suggestions": [
    {
      "title": "short imperative title",
      "prompt": "self-contained Mars task prompt ending with 'Save your work.'",
      "rationale": "cite event indices and quoted excerpts from this session",
      "verdict": "save|absorb|drop",
      "target_id": "<id>|null",
      "dup_of": "<id>|null"
    }
  ]
}

Rules:
- If there are no dissonant calls, return dissonantCalls: [] (empty array,
  not omitted).
- If the verify output is empty or missing, return verifyMismatch: null.
- Do not invent event indices. If you cannot pinpoint one, omit the entry.
- Quote text verbatim in evidence; do not paraphrase.`

const buildPrompt = (session: DeepReflectSession): string => {
  const head = {
    taskId: session.taskId,
    status: session.status,
    prompt: session.prompt,
    error: session.error,
    createdAt: session.createdAt,
    totals: session.totals,
    signals: session.signals,
    scores: session.scores,
  }
  const headJson = JSON.stringify(head, null, 2)
  const conversationJson = JSON.stringify(session.conversation)
  const verifyBlock = session.verifyOutput
    ? `\n\nVerify output (truncated to ~64 KB):\n\`\`\`\n${session.verifyOutput}\n\`\`\``
    : '\n\n(verify output: none recorded)'
  return `${SYNTHESIS_INSTRUCTIONS}

Session metadata:
${headJson}

Conversation (ClaudeEvent[] JSON; index into this array for eventIndex):
${conversationJson}${verifyBlock}`
}

const parseDissonantCalls = (raw: unknown): DissonantCall[] => {
  if (!Array.isArray(raw)) return []
  const out: DissonantCall[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const eventIndex = typeof o.eventIndex === 'number' ? o.eventIndex : null
    const tool = typeof o.tool === 'string' ? o.tool : null
    const statedIntent =
      typeof o.stated_intent === 'string'
        ? o.stated_intent
        : typeof o.statedIntent === 'string'
          ? o.statedIntent
          : null
    const actualOutcome =
      typeof o.actual_outcome === 'string'
        ? o.actual_outcome
        : typeof o.actualOutcome === 'string'
          ? o.actualOutcome
          : null
    const severityRaw = typeof o.severity === 'string' ? o.severity : null
    const severity: 'high' | 'medium' | 'low' | null =
      severityRaw === 'high' || severityRaw === 'medium' || severityRaw === 'low'
        ? severityRaw
        : null
    const evidence = typeof o.evidence === 'string' ? o.evidence : null
    if (
      eventIndex === null ||
      tool === null ||
      statedIntent === null ||
      actualOutcome === null ||
      severity === null ||
      evidence === null
    ) {
      continue
    }
    out.push({
      eventIndex,
      tool,
      statedIntent,
      actualOutcome,
      severity,
      evidence,
    })
  }
  return out
}

const parseVerifyMismatch = (raw: unknown): VerifyMismatch | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const claimed = typeof o.claimed === 'string' ? o.claimed : null
  const actual = typeof o.actual === 'string' ? o.actual : null
  const sev = typeof o.severity === 'string' ? o.severity : null
  if (claimed === null || actual === null) return null
  const severity: 'high' | 'medium' | 'low' =
    sev === 'high' || sev === 'medium' || sev === 'low' ? sev : 'medium'
  return { claimed, actual, severity }
}

const parseThrashing = (raw: unknown): ThrashingPattern[] => {
  if (!Array.isArray(raw)) return []
  const out: ThrashingPattern[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const pattern = typeof o.pattern === 'string' ? o.pattern : null
    const occurrences =
      typeof o.occurrences === 'number' ? o.occurrences : null
    const evidence = typeof o.evidence === 'string' ? o.evidence : null
    if (pattern === null || occurrences === null || evidence === null) continue
    out.push({ pattern, occurrences, evidence })
  }
  return out
}

const parseToolCallStats = (
  raw: unknown,
): { total: number; byName: Record<string, number> } => {
  if (!raw || typeof raw !== 'object') return { total: 0, byName: {} }
  const o = raw as Record<string, unknown>
  const total = typeof o.total === 'number' ? o.total : 0
  const byNameRaw = o.byName
  const byName: Record<string, number> = {}
  if (byNameRaw && typeof byNameRaw === 'object') {
    for (const [k, v] of Object.entries(byNameRaw as Record<string, unknown>)) {
      if (typeof v === 'number') byName[k] = v
    }
  }
  return { total, byName }
}

const parseSuggestions = (raw: unknown): VerdictedSuggestion[] => {
  if (!Array.isArray(raw)) return []
  const out: VerdictedSuggestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : ''
    const rationale =
      typeof o.rationale === 'string' ? o.rationale.trim() : null
    const verdict: SuggestionVerdict = parseVerdict(o.verdict)
    const targetId =
      typeof o.target_id === 'string'
        ? o.target_id
        : typeof o.targetId === 'string'
          ? o.targetId
          : null
    const dupOf =
      typeof o.dup_of === 'string'
        ? o.dup_of
        : typeof o.dupOf === 'string'
          ? o.dupOf
          : null
    if (!title || !prompt) continue
    out.push({
      title,
      prompt,
      rationale: rationale || null,
      verdict,
      targetId,
      dupOf,
    })
  }
  return out
}

export const parseDeepReflectionReport = (
  text: string,
): DeepReflectionReport | null => {
  const parsed = extractFirstJsonDocument(text)
  if (!parsed || typeof parsed !== 'object') return null
  const o = parsed as Record<string, unknown>
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    toolCallStats: parseToolCallStats(o.toolCallStats),
    dissonantCalls: parseDissonantCalls(o.dissonantCalls),
    verifyMismatch: parseVerifyMismatch(o.verifyMismatch),
    thrashingPatterns: parseThrashing(o.thrashingPatterns),
    rootCause: typeof o.rootCause === 'string' ? o.rootCause : '',
    suggestions: parseSuggestions(o.suggestions),
  }
}

export const runDeepReflector = async (
  session: DeepReflectSession,
  timeoutMs: number = 10 * 60 * 1000,
): Promise<DeepReflectionResult> => {
  const model = process.env.MARS_DEEP_REFLECT_MODEL ?? 'opus'
  const r = await runClaudeCode({
    cwd: getRepoRoot(),
    prompt: buildPrompt(session),
    timeoutMs,
    model,
  })
  const text = collectAssistantText(r.conversation) || r.stdout
  const report = parseDeepReflectionReport(text)
  return {
    report:
      report ??
      {
        summary: '',
        toolCallStats: { total: 0, byName: {} },
        dissonantCalls: [],
        verifyMismatch: null,
        thrashingPatterns: [],
        rootCause: '',
        suggestions: [],
      },
    rawOutput: text,
    exitCode: r.exitCode,
  }
}
