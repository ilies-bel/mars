import { runClaudeCode } from './git/claude'
import { getRepoRoot } from '../context'
import {
  collectAssistantText,
  extractFirstJsonDocument,
  parseVerdict,
  type SuggestionVerdict,
  type VerdictedSuggestion,
} from './reflector'
import type { DeepReflectArc } from './deep-reflect-query'
import type { ClaudeEvent } from './claude-stream'
import { digestArc } from './arc-digest'

export interface DissonantCall {
  taskId: string | null
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
  taskId: string | null
  claimed: string
  actual: string
  severity: 'high' | 'medium' | 'low'
}

export interface DeepReflectionReport {
  summary: string
  toolCallStats: { total: number; byName: Record<string, number> }
  dissonantCalls: DissonantCall[]
  verifyMismatch: VerifyMismatch | null
  verifyMismatches?: VerifyMismatch[]
  thrashingPatterns: ThrashingPattern[]
  rootCause: string
  suggestions: VerdictedSuggestion[]
}

export interface DeepReflectionResult {
  report: DeepReflectionReport
  rawOutput: string
  exitCode: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt size budgets
// ─────────────────────────────────────────────────────────────────────────────

/** Max chars to keep at the head of each tool_result body. */
const TOOL_RESULT_HEAD_CHARS = 400
/** Max chars to keep at the tail of each tool_result body. */
const TOOL_RESULT_TAIL_CHARS = 200
/** Max bytes for each task's serialized conversation after tool_result truncation. */
const TASK_CONVERSATION_CAP_BYTES = 150 * 1024
/** Max bytes for the total assembled prompt sent to the analyst. */
const TOTAL_PROMPT_CAP_BYTES = 400 * 1024

const SYNTHESIS_INSTRUCTIONS_ARC = `You are an expert post-mortem analyst for the Mars task orchestrator. You
will be given the FULL claude -p conversations for EVERY task in a single
Mars arc — the original task plus any retries, recovery (\`fix\`) tasks, and
follow-ups that share the same \`originId\`. Tasks are listed in
chronological order. You also receive per-step token+cost signals and the verify-step output recorded for each task.

Your job is to walk every task's transcript event-by-event AND to reason
across tasks. Cross-task signals matter most here: a recovery task that
failed because the parent left main dirty, a retry that re-did work the
parent already completed, a fix that papered over the wrong symptom.

Two KPIs drive every finding and suggestion:
- **Task completeness**: did the agent actually fulfil the task's acceptance criteria?
- **Token cost**: how much did this arc cost in tokens, and was the spend justified?
Every suggestion in \`suggestions[]\` MUST explicitly state its expected effect on
both KPIs (e.g. "saves ~30k tokens/arc by eliminating repeated reads; no impact on
completeness").

Procedure:

1. Walk every event in every task's conversation. Build a tool-call
   inventory across the entire arc.

2. Flag **dissonant tool calls** — calls where the result returned success
   but the actual outcome diverges from the assistant's stated goal in the
   surrounding text. Same examples as single-task mode (Edit that did not
   land, Bash exit 0 with failure stdout, Write to the wrong path, supervisor
   resolving a merge conflict by deleting both sides, etc.). For each
   dissonant call, cite:
   - \`task_id\`  — the Mars task id whose transcript contains the call,
   - \`eventIndex\` — 0-based index into THAT task's conversation array,
   - the tool name, stated_intent, actual_outcome, severity, and evidence.

3. Cross-reference end-of-turn assistant claims against each task's
   verifyOutput. Record one entry per affected task in \`verifyMismatches\`
   (an array). Use \`task_id\` to identify which task the mismatch belongs
   to.

4. Identify **arc-level patterns** in addition to per-task thrashing:
   - same file Read or Edited across multiple tasks with no convergence,
   - a recovery task that repeats the parent's failing strategy,
   - retries that thrash on the same merge conflict,
   - work done in task N that task N+1 silently undoes.
   Include these in \`thrashingPatterns\` with evidence that names the
   task ids.

5. Synthesize a 1–3 sentence rootCause that names the arc-level root cause
   (not just a per-task symptom). Suggestions follow the same verdict
   scheme as single-task mode: save | absorb | drop. Each suggestion's
   prompt MUST be self-contained and end with "Save your work."

Environmental failure classification:
- When a task's per-task digest (see below) sets \`environmentalFailure: true\`,
  classify that arc failure as **infrastructure** (quota, install, daemon),
  NOT as agent reasoning failure. Do NOT attribute rate-limit cascades, failed
  pnpm installs, or daemon kills to agent confusion.
- Name the orchestrator component responsible for the fix (e.g.
  "setup-phase retry budget", "code-phase rate-limit backoff", "pnpm install
  timeout in worktree-install.ts"). Use the \`environmentalFailureReason\`
  from the digest to identify the specific trigger.
- Similarly, tool_invoked error events in the step timeline (prefixed [T])
  represent orchestrator-level shell failures — flag them as infrastructure
  problems, not agent problems.

First-tool-call defect rule:
- If a task's digest sets \`firstToolCallFailed: true\`, flag that session
  as a **prompt/environment defect** rather than an agent reasoning failure.
  Cite the tool name from \`firstToolCallName\` and the argv when available.
  A coder whose very first tool call errors out almost certainly received a
  bad environment (broken worktree, missing file, wrong CWD) or a malformed
  prompt.

Digest citation rule:
- Findings MUST cite the per-task digest numbers (counts, event indices)
  rather than re-counting from the raw conversation. When the digest shows
  \`repeatedReads: [{path: "foo.ts", count: 5}]\`, write "5 Reads of foo.ts
  (per digest)" — do not scan the conversation yourself.
- Trust the digest's \`toolErrorCount\`, \`editRevertPairCount\`, and
  \`repeatedBashInvocations\` as authoritative mechanical counts.

Truncation awareness:
- Conversations supplied to you may have been truncated to fit context limits.
  Each task block states what was elided (if anything). Do NOT assume you saw
  the full conversation. When you cannot find an event cited in the metadata,
  note that it may have been elided rather than asserting it did not happen.

Output a SINGLE JSON document on stdout. No prose, no markdown, no fences.

Schema:

{
  "summary": "1-2 sentences on the arc outcome (mention task count + status mix)",
  "toolCallStats": { "total": N, "byName": { "Edit": N, "Bash": N } },
  "dissonantCalls": [
    {
      "task_id": "mars-xxxxx",
      "eventIndex": N,
      "tool": "Edit",
      "stated_intent": "...",
      "actual_outcome": "...",
      "severity": "high|medium|low",
      "evidence": "quoted excerpt"
    }
  ],
  "verifyMismatches": [
    {
      "task_id": "mars-xxxxx",
      "claimed": "...",
      "actual": "...",
      "severity": "high|medium|low"
    }
  ],
  "thrashingPatterns": [
    { "pattern": "...", "occurrences": N, "evidence": "task mars-xxxxx event 12; task mars-yyyyy event 7" }
  ],
  "rootCause": "1-3 sentences naming the arc-level cause",
  "suggestions": [
    {
      "title": "short imperative title",
      "prompt": "self-contained Mars task prompt ending with 'Save your work.'",
      "rationale": "cite task ids + event indices + quoted excerpts",
      "verdict": "save|absorb|drop",
      "target_id": "<id>|null",
      "dup_of": "<id>|null"
    }
  ]
}

Rules:
- If there are no dissonant calls anywhere in the arc, return
  dissonantCalls: [].
- If no task has a verify mismatch, return verifyMismatches: [].
- Always include \`task_id\` on dissonantCalls and verifyMismatches —
  without it, the entry cannot be cited and will be dropped.
- Do not invent event indices or task ids. If you cannot pinpoint one,
  omit the entry.
- Quote text verbatim in evidence; do not paraphrase.`

// ─────────────────────────────────────────────────────────────────────────────
// Conversation truncation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Truncate a tool_result body to head+tail so very long command outputs
 * (e.g. full test runs) don't dominate the context window.
 *
 * Handles two body shapes:
 * - string: truncate the string directly.
 * - array of content blocks: truncate the `text` field of each text block.
 */
const truncateBody = (body: unknown): unknown => {
  if (typeof body === 'string') {
    const total = body.length
    if (total <= TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS) return body
    const skipped = total - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS
    return (
      body.slice(0, TOOL_RESULT_HEAD_CHARS) +
      `\n…[${skipped} chars elided]…\n` +
      body.slice(-TOOL_RESULT_TAIL_CHARS)
    )
  }
  if (Array.isArray(body)) {
    return body.map((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return block
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') {
        return { ...b, text: truncateBody(b.text) }
      }
      return block
    })
  }
  return body
}

/**
 * Return a new conversation where every tool_result body in user messages
 * has been truncated to head TOOL_RESULT_HEAD_CHARS + tail TOOL_RESULT_TAIL_CHARS.
 * Events that carry no tool_results are returned unchanged (same reference).
 */
const truncateConversationToolResults = (conversation: ClaudeEvent[]): ClaudeEvent[] =>
  conversation.map((event) => {
    if (event.type !== 'user') return event
    const msg = event.message
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return event
    const msgObj = msg as Record<string, unknown>
    const content = msgObj.content
    if (!Array.isArray(content)) return event

    let anyModified = false
    const newContent = content.map((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return block
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_result') return block
      const newBodyContent = truncateBody(b.content)
      if (newBodyContent === b.content) return block
      anyModified = true
      return { ...b, content: newBodyContent }
    })

    if (!anyModified) return event
    return { ...event, message: { ...msgObj, content: newContent } }
  })

/**
 * Reduce a conversation array to fit within `maxBytes` of serialized JSON.
 *
 * Strategy: keep equal portions from the head and tail of the conversation.
 * A binary search finds the largest `k` such that first-k + last-k fits.
 * The middle `total - 2k` events are replaced with an elision note embedded
 * in the return value so the analyst knows what was dropped.
 *
 * Exported for unit testing.
 */
export const capConversation = (
  events: ClaudeEvent[],
  maxBytes: number,
): { events: ClaudeEvent[]; elisionNote: string | null } => {
  if (Buffer.byteLength(JSON.stringify(events), 'utf8') <= maxBytes) {
    return { events, elisionNote: null }
  }

  const total = events.length
  // Binary search: lo ≤ hi ≤ floor(total/2) ensures head and tail never overlap.
  let lo = 0
  let hi = Math.floor(total / 2)

  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const candidate = [...events.slice(0, mid), ...events.slice(total - mid)]
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  const keep = lo
  const retained = keep > 0 ? [...events.slice(0, keep), ...events.slice(total - keep)] : []
  const skipped = total - retained.length

  return {
    events: retained,
    elisionNote: `[${skipped} of ${total} middle events elided to fit ${Math.round(maxBytes / 1024)}KB cap; first ${keep} and last ${keep} events retained]`,
  }
}

/**
 * Truncate the final assembled prompt to at most `maxBytes` UTF-8 bytes.
 * When the cap triggers, a clear elision note is appended so the analyst
 * never assumes it received everything.
 *
 * The truncation point is estimated via character count (UTF-8 chars ≈ bytes
 * for ASCII-dominant prompts). A 5% safety margin avoids off-by-one on
 * multi-byte characters.
 */
const capPrompt = (prompt: string, maxBytes: number): string => {
  if (Buffer.byteLength(prompt, 'utf8') <= maxBytes) return prompt
  const note = `\n\n[PROMPT TRUNCATED: total size exceeded ${Math.round(maxBytes / 1024)}KB limit; remaining task conversations were elided. The mechanical digest per task above is complete and authoritative.]`
  const targetChars = Math.floor((maxBytes - Buffer.byteLength(note, 'utf8')) * 0.95)
  return prompt.slice(0, targetChars) + note
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────────────────────────────────────

export const buildArcPrompt = (arc: DeepReflectArc): string => {
  // 1. Compute mechanical digest for all tasks (no LLM).
  const arcDigest = digestArc(arc.tasks)

  const head = {
    originId: arc.originId,
    taskCount: arc.taskCount,
    statusMix: arc.statusMix,
    lastActivity: arc.lastActivity,
    totals: arc.totals,
    tasks: arc.tasks.map((t) => ({
      taskId: t.taskId,
      status: t.status,
      kind: t.kind,
      fixForTaskId: t.fixForTaskId,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      promptPreview: t.prompt.slice(0, 400),
      error: t.error,
      totals: t.totals,
      eventCount: t.conversation.length,
      hasTranscript: t.hasTranscript,
    })),
  }
  const headJson = JSON.stringify(head, null, 2)

  const taskBlocks = arc.tasks
    .map((t, idx) => {
      const taskDigest = arcDigest.tasks[idx]

      const meta = {
        taskId: t.taskId,
        status: t.status,
        kind: t.kind,
        fixForTaskId: t.fixForTaskId,
        prompt: t.prompt,
        error: t.error,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        totals: t.totals,
        signals: t.signals,
        toolCallCounts: t.toolCallCounts,
      }
      const metaJson = JSON.stringify(meta, null, 2)

      // 2a. Truncate tool_result bodies to head+tail to reduce raw size.
      const truncatedConvo = truncateConversationToolResults(t.conversation)

      // 2b. Cap per-task conversation at TASK_CONVERSATION_CAP_BYTES.
      const { events: cappedConvo, elisionNote } = capConversation(
        truncatedConvo,
        TASK_CONVERSATION_CAP_BYTES,
      )
      const conversationJson = JSON.stringify(cappedConvo)

      const capNote = elisionNote
        ? `\n\nConversation cap note for ${t.taskId}: ${elisionNote}`
        : ''

      const verifyBlock = t.verifyOutput
        ? `\n\nVerify output (raw) for ${t.taskId}:\n\`\`\`\n${t.verifyOutput}\n\`\`\``
        : `\n\n(verify output for ${t.taskId}: none recorded)`
      const transcriptNotes =
        t.transcriptNotes.length > 0
          ? `\n\nTranscript notes for ${t.taskId}:\n${t.transcriptNotes.map((n) => `- ${n}`).join('\n')}`
          : ''
      const transcriptNote = t.hasTranscript
        ? ''
        : `\n\n(no on-disk JSONL transcript resolved for ${t.taskId}; conversation array is empty)`

      return `── Task ${idx + 1} of ${arc.taskCount}: ${t.taskId} ──

Task metadata:
${metaJson}

Mechanical digest (LLM-free) for ${t.taskId}:
${JSON.stringify(taskDigest)}

Conversation for ${t.taskId} (ClaudeEvent[] JSON; index into this array for eventIndex):
${conversationJson}${capNote}${verifyBlock}${transcriptNotes}${transcriptNote}`
    })
    .join('\n\n')

  // 3. Build the step timeline section interleaved with tool_invoked errors.
  //    Spans use [S<n>] labels; tool errors use [T<n>] labels. Both are sorted
  //    by timestamp so the timeline reflects the actual chronological order.
  type TimelineItem =
    | { kind: 'span'; ts: string; line: string }
    | { kind: 'error'; ts: string; line: string }

  const items: TimelineItem[] = []

  let spanIdx = 0
  for (const s of arc.stepTimeline) {
    spanIdx++
    const worker = s.workerName ? ` worker=${s.workerName}` : ''
    const phase = s.phase ? ` phase=${s.phase}` : ''
    const session = s.sessionId ? ` session=${s.sessionId}` : ''
    const verify = s.verifyOutput ? ` verifyOutput=<${s.verifyOutput.length}b>` : ''
    const tx = s.transcript ? ` transcript=<${s.transcript.length}b>` : ''
    items.push({
      kind: 'span',
      ts: s.startedAt,
      line: `  [S${spanIdx}] ${s.startedAt} ${s.stepName}${worker}${phase} outcome=${s.outcome} durationMs=${s.durationMs}${session}${verify}${tx}`,
    })
  }

  let errorIdx = 0
  for (const e of arc.toolInvokedErrors) {
    errorIdx++
    const phase = e.phase ? ` phase=${e.phase}` : ''
    const argvStr = JSON.stringify(e.argv)
    const stderrNote = e.stderr.length > 0 ? ` stderr=<${e.stderr.length}b>` : ''
    items.push({
      kind: 'error',
      ts: e.timestamp,
      line: `  [T${errorIdx}] ${e.timestamp} TOOL_ERROR tool=${e.tool} argv=${argvStr} exitCode=${e.exitCode}${phase}${stderrNote}`,
    })
  }

  items.sort((a, b) => a.ts.localeCompare(b.ts))

  const timelineLines = items.map((item) => item.line)
  const timelineSection =
    items.length > 0
      ? `Step timeline (${arc.stepTimeline.length} span(s), ${arc.toolInvokedErrors.length} tool error(s), started_at order):\n${timelineLines.join('\n')}`
      : 'Step timeline: (no step spans or tool errors recorded for this arc)'

  // 4. Assemble the full prompt and apply the total size cap.
  const fullPrompt = `${SYNTHESIS_INSTRUCTIONS_ARC}

Arc metadata:
${headJson}

${timelineSection}

${taskBlocks}`

  return capPrompt(fullPrompt, TOTAL_PROMPT_CAP_BYTES)
}

const parseDissonantCalls = (raw: unknown): DissonantCall[] => {
  if (!Array.isArray(raw)) return []
  const out: DissonantCall[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const eventIndex = typeof o.eventIndex === 'number' ? o.eventIndex : null
    const tool = typeof o.tool === 'string' ? o.tool : null
    const taskId =
      typeof o.task_id === 'string'
        ? o.task_id
        : typeof o.taskId === 'string'
          ? o.taskId
          : null
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
      taskId,
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

const parseVerifyMismatchEntry = (raw: unknown): VerifyMismatch | null => {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const claimed = typeof o.claimed === 'string' ? o.claimed : null
  const actual = typeof o.actual === 'string' ? o.actual : null
  const sev = typeof o.severity === 'string' ? o.severity : null
  const taskId =
    typeof o.task_id === 'string'
      ? o.task_id
      : typeof o.taskId === 'string'
        ? o.taskId
        : null
  if (claimed === null || actual === null) return null
  const severity: 'high' | 'medium' | 'low' =
    sev === 'high' || sev === 'medium' || sev === 'low' ? sev : 'medium'
  return { taskId, claimed, actual, severity }
}

const parseVerifyMismatches = (raw: unknown): VerifyMismatch[] => {
  if (!Array.isArray(raw)) return []
  const out: VerifyMismatch[] = []
  for (const item of raw) {
    const parsed = parseVerifyMismatchEntry(item)
    if (parsed) out.push(parsed)
  }
  return out
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
    const rootCauseKey =
      typeof o.rootCauseKey === 'string' ? o.rootCauseKey.trim() : ''
    const affectedTaskIds = Array.isArray(o.affectedTaskIds)
      ? (o.affectedTaskIds as unknown[]).filter(
          (id): id is string => typeof id === 'string',
        )
      : []
    const frequency =
      typeof o.frequency === 'number'
        ? o.frequency
        : affectedTaskIds.length || 1
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
    const rawConfidence = o.confidence
    const confidence =
      typeof rawConfidence === 'number' &&
      Number.isFinite(rawConfidence) &&
      rawConfidence >= 0 &&
      rawConfidence <= 1
        ? rawConfidence
        : 0
    const rawKind = o.kind
    const kind: 'mechanical' | 'architectural' =
      rawKind === 'mechanical' || rawKind === 'architectural' ? rawKind : 'mechanical'
    if (!title || !prompt) continue
    out.push({
      title,
      prompt,
      rationale: rationale || null,
      rootCauseKey,
      affectedTaskIds,
      frequency,
      confidence,
      kind,
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
  // Arc-level reports use `verifyMismatches` (plural array). Single-task
  // reports use `verifyMismatch` (singular). Accept both; normalise into
  // both fields so consumers can pick whichever they need.
  const singular = parseVerifyMismatchEntry(o.verifyMismatch)
  const plural = parseVerifyMismatches(o.verifyMismatches)
  const verifyMismatches =
    plural.length > 0 ? plural : singular ? [singular] : []
  const verifyMismatch = verifyMismatches[0] ?? null
  return {
    summary: typeof o.summary === 'string' ? o.summary : '',
    toolCallStats: parseToolCallStats(o.toolCallStats),
    dissonantCalls: parseDissonantCalls(o.dissonantCalls),
    verifyMismatch,
    verifyMismatches,
    thrashingPatterns: parseThrashing(o.thrashingPatterns),
    rootCause: typeof o.rootCause === 'string' ? o.rootCause : '',
    suggestions: parseSuggestions(o.suggestions),
  }
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
})

export const runDeepReflectorArc = async (
  arc: DeepReflectArc,
  timeoutMs: number = 10 * 60 * 1000,
): Promise<DeepReflectionResult> => {
  const model = process.env.MARS_DEEP_REFLECT_MODEL ?? 'opus'
  const r = await runClaudeCode({
    cwd: getRepoRoot(),
    prompt: buildArcPrompt(arc),
    timeoutMs,
    model,
  })
  const text = collectAssistantText(r.conversation) || r.stdout
  const report = parseDeepReflectionReport(text)
  return {
    report: report ?? emptyReport(),
    rawOutput: text,
    exitCode: r.exitCode,
  }
}
