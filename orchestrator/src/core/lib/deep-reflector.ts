import { runHeadlessProvider } from '../workers/providers'
import { getRepoRoot } from '../context'
import {
  collectAssistantText,
  extractFirstJsonDocument,
  parseVerdict,
  parseAndValidateOutcome,
  type SuggestionVerdict,
  type VerdictedSuggestion,
  type VerdictedScorerSuggestion,
  type VerdictedCapabilityGapSuggestion,
} from './reflector'
import { loadLeverRegistry, formatLeverList } from './lever-registry'
import type { DeepReflectArc, SessionArcsResult } from './deep-reflect-query'
import type { ClaudeEvent } from './claude-stream'
import { digestArc } from './arc-digest'
import { insertMemoryPacket } from '../store/memory-packet-store'
import { getTask } from '../queue'
import { isAutoReflectDisabled } from './auto-reflect-gate'

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
  /**
   * The second reflection output type (PRD 6988ed3b): suggested Scorers for
   * MEASUREMENT GAPS — the verify gate passed (or vacuously passed) while
   * transcript analysis found a quality dimension no gate grades. Empty when
   * the arc shows no such gap.
   */
  scorerSuggestions: VerdictedScorerSuggestion[]
  /**
   * Capability-gap findings: steps that self-reported they lacked a tool or
   * capability needed to do their job (e.g. behaviour-verify that could not
   * exercise the UI because no browser-driving tool was available). Each entry
   * is a proposal for a human to act on — the framework never auto-installs.
   * Empty when no step reported a capability gap.
   */
  capabilityGapSuggestions: VerdictedCapabilityGapSuggestion[]
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
/**
 * Hard ceiling for a SINGLE task's serialized conversation, applied on top of
 * the shared per-task budget. Even when an arc has one task and the whole
 * prompt cap is available, no transcript may claim more than this.
 */
const TASK_CONVERSATION_CAP_BYTES = 150 * 1024
/** Max bytes for the total assembled prompt sent to the analyst. */
const TOTAL_PROMPT_CAP_BYTES = 400 * 1024
/** Max chars of a task's prompt embedded in its metadata block. */
const TASK_PROMPT_CAP_CHARS = 4_000
/** Max chars of a task's error string embedded in its metadata block. */
const TASK_ERROR_CAP_CHARS = 2_000
/** Max chars of raw verify output embedded per task. */
const VERIFY_OUTPUT_CAP_CHARS = 8_000
/** Max chars of a single transcript note embedded per task. */
const TRANSCRIPT_NOTE_CAP_CHARS = 500
/** Bytes held back from the block budget for the whole-block-drop notice. */
const DROP_NOTE_RESERVE_BYTES = 512

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

6. Check for a **measurement gap** and, when one exists, emit a
   **scorerSuggestion**. A Scorer is a durable per-Workflow quality rubric —
   NOT work to do. Emit one ONLY when BOTH hold:
   - the verify step succeeded (or vacuously passed — e.g. "pass" with 0
     tests run, or a verifyMismatches entry shows the claim diverged from
     the gate's actual output), AND
   - transcript analysis found a quality dissonance the pipeline's gate
     cannot see: verifyMismatches, high-severity dissonantCalls, or a
     root cause recurring across tasks of the same workflow kind.
   Decision rule: if the finding is fixable by a code or workflow change,
   it belongs in \`suggestions\` (a draft-proposal), NOT here. Only
   "no gate grades dimension X on this pipeline" becomes a scorer
   suggestion. Each scorer suggestion carries:
   - \`workflow\`: the target Workflow kind — the \`kind\` value from the
     task metadata of the tasks that exhibit the gap (e.g. "task", "fix").
   - \`title\`: a short human label for the quality dimension graded.
   - \`rubric\`: a SELF-CONTAINED scoring prompt an evaluator LLM applies to
     a completed Workflow instance's artifacts (diff, verify output,
     transcript digest). It must generalize to FUTURE instances of that
     Workflow — no task ids, no arc-specific file names, no references to
     this arc. The evaluator's output contract is fixed by the system (a
     continuous 0..1 score plus a one-line rationale); the rubric describes
     WHAT to grade and how to anchor the extremes (what a 0 looks like,
     what a 1 looks like).
   - \`confidence\`: 0..1 — how confident you are that this dimension is a
     real, recurring measurement gap (not a one-off).
   - \`evidence\`: quoted excerpts (with task ids / event indices) of the
     concrete dissonant calls or verify mismatches that motivated it.
   - \`verdict\`: save | absorb | drop — same scheme as suggestions.
   If there is no measurement gap, return scorerSuggestions: [].

7. Check whether any step SELF-REPORTED that it lacked a tool or capability
   it needed to do its job (e.g. behaviour verification that could not
   exercise the UI because no interactive/browser tool was available in the
   environment). Look for explicit self-report language in step traces: phrases
   like "no browser tool", "tool unavailable", "cannot exercise", "lacked the
   tool", or a CAN'T-VERIFY outcome citing a missing capability. When a step's
   trace shows such a gap, emit a capabilityGapSuggestion describing:
   - \`stepName\`: the pipeline step that reported the gap (e.g. 'behaviour-verify').
   - \`capability\`: a short label for what was missing (e.g. 'browser/UI-driving MCP tool').
   - \`description\`: what the step could not do, and what wiring the capability
     would unlock for the operator. Be concrete but never prescriptive about
     HOW to install or configure — that decision belongs to the human.
   - \`evidence\`: quoted excerpts from the step trace.
   - \`verdict\`: save | absorb | drop — same scheme as suggestions.
   Never suggest auto-installing or auto-configuring anything. If no step
   reported a capability gap, return capabilityGapSuggestions: [].

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
      "dup_of": "<id>|null",
      "outcome": {
        "type": "lever",
        "lever": { "id": "caps.implement", "currentValue": "12", "proposedValue": "8" }
      }
    }
  ],
  "scorerSuggestions": [
    {
      "workflow": "task",
      "title": "short quality-dimension label",
      "rubric": "self-contained scoring prompt applied to a Workflow instance's diff, verify output, and transcript digest; anchors 0 and 1; no arc-specific references",
      "confidence": 0.8,
      "evidence": ["quoted excerpt citing task mars-xxxxx event 12"],
      "verdict": "save|absorb|drop"
    }
  ],
  "capabilityGapSuggestions": [
    {
      "stepName": "behaviour-verify",
      "capability": "browser/UI-driving MCP tool",
      "description": "Behaviour verification could not exercise the UI surface because no browser-driving tool was available. Wiring a browser/UI-driving MCP tool would enable per-criterion verification on live surfaces.",
      "evidence": ["quoted excerpt from the step trace showing the self-reported gap"],
      "verdict": "save|absorb|drop"
    }
  ]
}

Rules:
- If there are no dissonant calls anywhere in the arc, return
  dissonantCalls: [].
- If no task has a verify mismatch, return verifyMismatches: [].
- If the arc shows no measurement gap, return scorerSuggestions: [].
  Most arcs have none — a scorer suggestion is rare and must be grounded
  in a verify gate that passed while quality dissonance was visible.
- If no step self-reported a capability gap, return capabilityGapSuggestions: [].
  Only emit an entry when the step's trace EXPLICITLY states it lacked a tool —
  do not infer gaps from poor results alone.
- Always include \`task_id\` on dissonantCalls and verifyMismatches —
  without it, the entry cannot be cited and will be dropped.
- Do not invent event indices or task ids. If you cannot pinpoint one,
  omit the entry.
- Quote text verbatim in evidence; do not paraphrase.
- LEVER BINDING (required on every suggestion): Each suggestion MUST include
  an \`outcome\` field. Use \`{ "type": "lever", "lever": { "id": "<lever-id>",
  "currentValue": "<current>", "proposedValue": "<new-value>" } }\` when a
  lever in the registry (provided above) directly expresses the change. Use
  \`{ "type": "leverGap", "leverGap": { "proposedLeverId": "<slug>",
  "family": "<family>", "whatItWouldControl": "<description>" } }\` when no
  lever exists. BIAS TOWARD GAPS when uncertain — a wrongly-bound lever
  tells the operator to turn the wrong dial. A suggestion without a valid
  \`outcome\` will be REJECTED and never filed.`

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
 * Truncate a free-text field (never a serialized JSON document) to `maxChars`,
 * appending an explicit elision marker.
 *
 * Safe to apply to a string BEFORE it is embedded in a JSON document: the
 * truncation happens on the value, and `JSON.stringify` re-escapes it, so the
 * surrounding document stays syntactically valid.
 */
const truncateText = (text: string, maxChars: number): string =>
  text.length <= maxChars
    ? text
    : `${text.slice(0, maxChars)}\n…[${text.length - maxChars} chars elided]…`

/**
 * Reduce an array to fit within `maxBytes` by dropping WHOLE elements from the
 * middle — never by slicing the rendered string.
 *
 * A binary search finds the largest `k` such that first-k + last-k fits under
 * `size`. Because only complete elements are ever removed, the rendering of
 * the result is always structurally intact (valid JSON, whole blocks, …).
 */
const capArrayBySize = <T>(
  items: readonly T[],
  maxBytes: number,
  size: (candidate: readonly T[]) => number,
): { items: T[]; dropped: number; kept: number } => {
  const total = items.length
  // Binary search: lo ≤ hi ≤ floor(total/2) ensures head and tail never overlap.
  let lo = 0
  let hi = Math.floor(total / 2)

  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const candidate = [...items.slice(0, mid), ...items.slice(total - mid)]
    if (size(candidate) <= maxBytes) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  const keep = lo
  const retained = keep > 0 ? [...items.slice(0, keep), ...items.slice(total - keep)] : []
  return { items: retained, dropped: total - retained.length, kept: keep }
}

/** {@link capArrayBySize} measured by the array's serialized-JSON byte length. */
const capArrayToJsonBytes = <T>(
  items: readonly T[],
  maxBytes: number,
  indent?: number,
): { items: T[]; dropped: number; kept: number } =>
  capArrayBySize(items, maxBytes, (candidate) =>
    Buffer.byteLength(JSON.stringify(candidate, null, indent), 'utf8'),
  )

/** {@link capArrayBySize} measured by the byte length of `blocks.join(sep)`. */
const capBlocksByJoinedSize = (
  blocks: readonly string[],
  maxBytes: number,
  sep: string,
): { items: string[]; dropped: number; kept: number } =>
  capArrayBySize(blocks, maxBytes, (candidate) =>
    Buffer.byteLength(candidate.join(sep), 'utf8'),
  )

/**
 * Reduce a conversation array to fit within `maxBytes` of serialized JSON.
 *
 * Strategy: keep equal portions from the head and tail of the conversation.
 * Only whole ClaudeEvents are dropped, so `JSON.stringify` of the result is
 * always parseable — the analyst can never be handed a half-written object.
 * The middle events are replaced with an elision note returned alongside the
 * events so the analyst knows what was dropped.
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
  const { items: retained, dropped, kept } = capArrayToJsonBytes(events, maxBytes)

  return {
    events: retained,
    elisionNote: `[${dropped} of ${total} middle events elided to fit ${Math.round(maxBytes / 1024)}KB cap; first ${kept} and last ${kept} events retained]`,
  }
}

/**
 * Distribute `totalBytes` of conversation budget across tasks using max-min
 * fair sharing: every task starts with an equal share, a task that needs less
 * than its share hands the surplus back to the pool, and the surplus is
 * re-divided among the tasks that are still over budget.
 *
 * This is what stops ONE pathological transcript from eating the whole prompt
 * cap and starving the other tasks in the arc — it can never claim more than
 * its fair share, no matter how large it is.
 *
 * Exported for unit testing.
 */
export const allocateConversationBudgets = (
  sizes: readonly number[],
  totalBytes: number,
): number[] => {
  const budgets = new Array<number>(sizes.length).fill(0)
  // Smallest transcripts first: they under-spend their share, and the leftover
  // rolls forward to the larger ones.
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b])
  let pool = Math.max(0, totalBytes)
  let remaining = order.length
  for (const i of order) {
    const share = Math.max(
      0,
      Math.min(TASK_CONVERSATION_CAP_BYTES, Math.floor(pool / remaining)),
    )
    budgets[i] = share
    pool -= Math.min(sizes[i], share)
    remaining -= 1
  }
  return budgets
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

  // 2. Build each task's "shell" — everything in the block except the
  //    conversation JSON. Every free-text field is truncated as a STRING
  //    before serialization, so the embedded JSON documents stay valid.
  const shells = arc.tasks.map((t, idx) => {
    const taskDigest = arcDigest.tasks[idx]

    const meta = {
      taskId: t.taskId,
      status: t.status,
      kind: t.kind,
      fixForTaskId: t.fixForTaskId,
      prompt: truncateText(t.prompt, TASK_PROMPT_CAP_CHARS),
      error: t.error === null ? null : truncateText(t.error, TASK_ERROR_CAP_CHARS),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      totals: t.totals,
      signals: t.signals,
      // Post-merge Scorer results (record-only quality signal, PRD
      // 6cf85bc9) — lets arc reflection cite a quality trend as evidence.
      scorerResults: t.scorerResults,
      toolCallCounts: t.toolCallCounts,
    }
    const metaJson = JSON.stringify(meta, null, 2)

    const verifyBlock = t.verifyOutput
      ? `\n\nVerify output (raw) for ${t.taskId}:\n\`\`\`\n${truncateText(t.verifyOutput, VERIFY_OUTPUT_CAP_CHARS)}\n\`\`\``
      : `\n\n(verify output for ${t.taskId}: none recorded)`
    const transcriptNotes =
      t.transcriptNotes.length > 0
        ? `\n\nTranscript notes for ${t.taskId}:\n${t.transcriptNotes
            .map((n) => `- ${truncateText(n, TRANSCRIPT_NOTE_CAP_CHARS)}`)
            .join('\n')}`
        : ''
    const transcriptNote = t.hasTranscript
      ? ''
      : `\n\n(no on-disk JSONL transcript resolved for ${t.taskId}; conversation array is empty)`

    const header = `── Task ${idx + 1} of ${arc.taskCount}: ${t.taskId} ──

Task metadata:
${metaJson}

Mechanical digest (LLM-free) for ${t.taskId}:
${JSON.stringify(taskDigest)}

Conversation for ${t.taskId} (ClaudeEvent[] JSON; index into this array for eventIndex):
`
    const tail = `${verifyBlock}${transcriptNotes}${transcriptNote}`

    // 2a. Truncate tool_result bodies to head+tail to reduce raw size.
    const truncatedConvo = truncateConversationToolResults(t.conversation)

    return { task: t, header, tail, truncatedConvo }
  })

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

  // 4. Assemble the prompt within the total size cap.
  //
  //    The cap is enforced STRUCTURALLY, never by slicing the assembled
  //    string: the prompt embeds one serialized ClaudeEvent[] per task, and a
  //    byte-offset cut lands inside that blob and hands the analyst invalid
  //    JSON. Instead the budget is spent on whole conversation events, and —
  //    as a last resort — whole task blocks.
  const leverList = formatLeverList(loadLeverRegistry())
  const preamble = `${SYNTHESIS_INSTRUCTIONS_ARC}

Lever registry (bind each suggestion's outcome to a lever id from this list, or declare a leverGap):
${leverList}

Arc metadata:
${headJson}

${timelineSection}

`
  const fixedBytes =
    Buffer.byteLength(preamble, 'utf8') +
    shells.reduce(
      // +2 for the '\n\n' separator that joins the blocks.
      (sum, s) => sum + Buffer.byteLength(`${s.header}${s.tail}`, 'utf8') + 2,
      0,
    )

  // Per-task conversation budget: max-min fair sharing of whatever the fixed
  // sections leave behind, so one pathological transcript cannot starve the
  // rest of the arc.
  const conversationSizes = shells.map((s) =>
    Buffer.byteLength(JSON.stringify(s.truncatedConvo), 'utf8'),
  )
  const budgets = allocateConversationBudgets(
    conversationSizes,
    TOTAL_PROMPT_CAP_BYTES - fixedBytes,
  )

  const taskBlockList = shells.map((s, idx) => {
    const { events: cappedConvo, elisionNote } = capConversation(
      s.truncatedConvo,
      budgets[idx],
    )
    const capNote = elisionNote
      ? `\n\nConversation cap note for ${s.task.taskId}: ${elisionNote}`
      : ''
    return `${s.header}${JSON.stringify(cappedConvo)}${capNote}${s.tail}`
  })

  // Safety net: when the fixed sections alone blow the cap (a very wide arc,
  // or huge metadata), drop WHOLE task blocks from the middle rather than
  // cutting one in half.
  const budgetForBlocks = TOTAL_PROMPT_CAP_BYTES - Buffer.byteLength(preamble, 'utf8')
  const joined = taskBlockList.join('\n\n')
  if (Buffer.byteLength(joined, 'utf8') <= budgetForBlocks) {
    return `${preamble}${joined}`
  }

  const total = taskBlockList.length
  // Reserve room for the drop note itself so appending it cannot re-breach the cap.
  const { items: keptBlocks } = capBlocksByJoinedSize(
    taskBlockList,
    budgetForBlocks - DROP_NOTE_RESERVE_BYTES,
    '\n\n',
  )
  const dropNote = `\n\n[PROMPT CAP: ${total - keptBlocks.length} of ${total} task block(s) dropped WHOLE to fit the ${Math.round(
    TOTAL_PROMPT_CAP_BYTES / 1024,
  )}KB limit; no conversation was cut mid-document. The arc metadata and the mechanical digest for the retained tasks are complete and authoritative.]`
  return `${preamble}${keptBlocks.join('\n\n')}${dropNote}`
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
  const registry = loadLeverRegistry()
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
    const outcome = parseAndValidateOutcome(o.outcome, registry)
    if (!outcome) continue
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
      outcome,
    })
  }
  return out
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

const parseCapabilityGapSuggestions = (raw: unknown): VerdictedCapabilityGapSuggestion[] => {
  if (!Array.isArray(raw)) return []
  const out: VerdictedCapabilityGapSuggestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const stepName = typeof o.stepName === 'string' ? o.stepName.trim() : ''
    const capability = typeof o.capability === 'string' ? o.capability.trim() : ''
    const description = typeof o.description === 'string' ? o.description.trim() : ''
    // stepName and capability are load-bearing; an entry missing either cannot
    // be meaningfully surfaced to the operator.
    if (!stepName || !capability) continue
    const evidence = Array.isArray(o.evidence)
      ? o.evidence.filter((e): e is string => typeof e === 'string')
      : []
    const verdict: SuggestionVerdict = parseVerdict(o.verdict)
    out.push({ stepName, capability, description, evidence, verdict })
  }
  return out
}

const parseScorerSuggestions = (raw: unknown): VerdictedScorerSuggestion[] => {
  if (!Array.isArray(raw)) return []
  const out: VerdictedScorerSuggestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const workflow = typeof o.workflow === 'string' ? o.workflow.trim() : ''
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    const rubric = typeof o.rubric === 'string' ? o.rubric.trim() : ''
    // workflow, title, and rubric are load-bearing (fingerprint + evaluator
    // prompt); an entry missing any of them cannot become a Scorer record.
    if (!workflow || !title || !rubric) continue
    const confidence =
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? clamp01(o.confidence)
        : 0.5
    const evidence = Array.isArray(o.evidence)
      ? o.evidence.filter((e): e is string => typeof e === 'string')
      : []
    const verdict: SuggestionVerdict = parseVerdict(o.verdict)
    out.push({ workflow, title, rubric, confidence, evidence, verdict })
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
    scorerSuggestions: parseScorerSuggestions(o.scorerSuggestions),
    capabilityGapSuggestions: parseCapabilityGapSuggestions(o.capabilityGapSuggestions),
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
  scorerSuggestions: [],
  capabilityGapSuggestions: [],
})

/**
 * Resolve the memory-packet domain for an arc: the origin task's workflow name,
 * its first tag, or the fallback literal 'general'.
 */
export const resolveArcDomain = async (originId: string): Promise<string> => {
  const task = await getTask(originId)
  return task?.workflow ?? task?.tags?.[0] ?? 'general'
}

export const runDeepReflectorArc = async (
  arc: DeepReflectArc,
  timeoutMs: number = Number(process.env.MARS_DEEP_REFLECT_TIMEOUT_MS) || 10 * 60 * 1000,
): Promise<DeepReflectionResult> => {
  const model = process.env.MARS_DEEP_REFLECT_MODEL
  const r = await runHeadlessProvider(buildArcPrompt(arc), {
    cwd: getRepoRoot(),
    timeoutMs,
    ...(model !== undefined ? { model } : {}),
    modelTier: 'flagship',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  })
  const text = collectAssistantText(r.conversation) || r.stdout
  const report = parseDeepReflectionReport(text)

  // Persist save-verdict suggestions as domain-scoped memory packets.
  // Auto-reflect and MARS_REFLECT_DISABLED independently gate this automatic
  // follow-on; the report itself remains available to manual CLI commands.
  if (
    !isAutoReflectDisabled() &&
    process.env.MARS_REFLECT_DISABLED !== '1' &&
    r.exitCode === 0 &&
    report !== null
  ) {
    const domain = await resolveArcDomain(arc.originId)
    for (const suggestion of report.suggestions) {
      if (suggestion.verdict === 'save') {
        await insertMemoryPacket({
          domain,
          text: suggestion.prompt,
          salience: suggestion.confidence ?? 0.7,
          originArcId: arc.originId,
        })
      }
    }
  }

  return {
    report: report ?? emptyReport(),
    rawOutput: text,
    exitCode: r.exitCode,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session-scoped reflection
// ─────────────────────────────────────────────────────────────────────────────

const SYNTHESIS_INSTRUCTIONS_SESSION = `You are a harness-fitness analyst for the Mars task orchestrator.
You are given a summary of ALL arcs that ran during a single operator session,
together with their workflow step records (setup/code/verify/merge durations,
retry counts, error summaries) and per-arc token spend.

Your job is to assess TWO things and produce actionable verdicts:

1. STEP FITNESS — for each workflow step type (setup, code, verify, merge):
   - Was the step appropriately sized? (too slow → restructure; missing retry
     → add retry; unnecessary overhead → remove or slim down)
   - Are any steps being retried repeatedly? (attempt > 1 is a red flag)
   - Are verify steps failing often? (thrashing CPU on tests → prescribe
     parallelisation or scope reduction in the workflow file)
   - Each step-fitness verdict MUST name the concrete workflow file to edit
     (e.g. "edit orchestrator/src/workflows/implement-workflow.ts, step 'verify',
     to add a --passWithNoTests flag") and end with "Run mars workflow validate
     <workflow-name> to check the edit."

2. RESOURCE SPEND — for token and CPU patterns:
   - Identify which arcs spent the most tokens and why.
   - If high input-token spend is due to repeated file reads, name the remedy:
     "Add the codegraph MCP tool so the coder can call codegraph query instead
     of reading multiple files."
   - If token spend is high due to wide context gathering, name the remedy:
     "Wire the progressive-discovery skill (context-gathering-brief.ts) so the
     coder starts with targeted lookups before loading full files."
   - If cache-hit ratio is low, suggest prompt restructuring.
   - For CPU-bound verify steps (long durationMs), suggest parallelisation or
     targeted test runs in the workflow.
   - Each resource verdict MUST state the expected token/CPU saving.

Cross-arc patterns:
- Same failure repeating across arcs → structural harness fix, not a one-off.
- One arc dominates token spend → investigate why (bad prompt? excessive reads?).

Output a SINGLE JSON document on stdout. No prose, no markdown, no fences.

Schema (same as arc-reflect):
{
  "summary": "1-2 sentences on the session outcome (arc count, status mix, total tokens)",
  "toolCallStats": { "total": 0, "byName": {} },
  "dissonantCalls": [],
  "verifyMismatches": [],
  "thrashingPatterns": [
    { "pattern": "...", "occurrences": N, "evidence": "arc-id step-name attempt-count" }
  ],
  "rootCause": "1-3 sentences naming the session-level harness fitness issue",
  "suggestions": [
    {
      "title": "short imperative title",
      "prompt": "self-contained task prompt ending with 'Run mars workflow validate <name> to check.' or 'Save your work.'",
      "rationale": "cite arc ids + step names + token counts",
      "verdict": "save|absorb|drop",
      "target_id": null,
      "dup_of": null,
      "outcome": {
        "type": "lever",
        "lever": { "id": "caps.implement", "currentValue": "12", "proposedValue": "8" }
      }
    }
  ]
}

Rules:
- dissonantCalls and verifyMismatches MUST always be empty arrays — session
  mode does not re-analyse individual tool call transcripts.
- Every suggestion's prompt must be self-contained and name a specific file.
- Do not invent arc IDs or step names. Use only what is provided.
- rootCauseKey in the suggestion is derived from the title: convert to
  snake_case (the consumer does this automatically; omit the field here).
- LEVER BINDING (required on every suggestion): Each suggestion MUST include
  an \`outcome\` field. Use \`{ "type": "lever", ... }\` when a lever in the
  registry (provided above) directly expresses the change, or \`{ "type":
  "leverGap", ... }\` when none does. A suggestion without a valid \`outcome\`
  will be REJECTED and never filed.`

/** Max bytes for the total assembled session prompt. */
const SESSION_PROMPT_CAP_BYTES = 300 * 1024

/**
 * Build the session-scoped reflection prompt.
 *
 * Unlike the arc prompt, this does NOT include full conversation transcripts —
 * the session view is a higher-level harness fitness analysis. It includes:
 * - Per-arc metadata (status, tokens, step timeline summary)
 * - workflow_step_runs records (retry counts, durations, error summaries)
 * - Token spend breakdown
 */
export const buildSessionPrompt = (result: SessionArcsResult): string => {
  const arcsSummary = result.arcs.map((arc) => {
    const statusMixStr = Object.entries(arc.statusMix)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')

    const stepTimelineLines = arc.stepTimeline.map(
      (s) =>
        `  ${s.stepName} phase=${s.phase ?? 'n/a'} outcome=${s.outcome} durationMs=${s.durationMs}` +
        (s.workerName ? ` worker=${s.workerName}` : ''),
    )

    return {
      originId: arc.originId,
      taskCount: arc.taskCount,
      statusMix: arc.statusMix,
      statusMixStr,
      totals: arc.totals,
      lastActivity: arc.lastActivity,
      taskSummaries: arc.tasks.map((t) => ({
        taskId: t.taskId,
        status: t.status,
        kind: t.kind,
        promptPrefix: t.prompt.slice(0, 200),
        error: t.error,
        weightedTokens: Math.round(
          t.totals.inputTokens +
            t.totals.outputTokens +
            t.totals.cacheCreateTokens +
            t.totals.cacheReadTokens * 0.1,
        ),
      })),
      stepTimelineLines,
    }
  })

  const sessionMeta = {
    sessionId: result.sessionId,
    arcCount: result.arcs.length,
    totalWeightedTokens: result.arcs.reduce((s, a) => s + a.totals.totalWeightedTokens, 0),
    statusMix: result.arcs.reduce(
      (acc, arc) => {
        for (const [k, v] of Object.entries(arc.statusMix)) acc[k] = (acc[k] ?? 0) + v
        return acc
      },
      {} as Record<string, number>,
    ),
  }

  const sessionMetaJson = JSON.stringify(sessionMeta, null, 2)

  // Group step runs by arc origin ID for readability.
  const taskToOrigin = new Map<string, string>()
  for (const arc of result.arcs) {
    for (const t of arc.tasks) taskToOrigin.set(t.taskId, arc.originId)
  }
  const groupStepRuns = (
    runs: readonly SessionArcsResult['stepRuns'][number][],
  ): Record<string, SessionArcsResult['stepRuns'][number][]> => {
    const byArc: Record<string, SessionArcsResult['stepRuns'][number][]> = {}
    for (const sr of runs) {
      const origin = taskToOrigin.get(sr.taskId) ?? sr.taskId
      byArc[origin] = byArc[origin] ?? []
      byArc[origin].push(sr)
    }
    return byArc
  }

  const sessionLeverList = formatLeverList(loadLeverRegistry())
  const render = (
    arcs: typeof arcsSummary,
    stepRuns: readonly SessionArcsResult['stepRuns'][number][],
    elisionNote: string,
  ): string => `${SYNTHESIS_INSTRUCTIONS_SESSION}

Lever registry (bind each suggestion's outcome to a lever id from this list, or declare a leverGap):
${sessionLeverList}

Session metadata:
${sessionMetaJson}

Arc summaries (${arcs.length} of ${arcsSummary.length} arc(s)):
${JSON.stringify(arcs, null, 2)}

Workflow step records by arc (workflow_step_runs — retry counts, durations, errors):
${JSON.stringify(groupStepRuns(stepRuns), null, 2)}${elisionNote}`

  const full = render(arcsSummary, result.stepRuns, '')
  if (Buffer.byteLength(full, 'utf8') <= SESSION_PROMPT_CAP_BYTES) return full

  // Over cap: reduce STRUCTURALLY — drop whole arcs and whole step-run records
  // from the middle — never by slicing the serialized JSON, which would hand
  // the analyst a syntactically invalid document.
  const fixedBytes = Buffer.byteLength(render([], [], ''), 'utf8') + DROP_NOTE_RESERVE_BYTES
  const available = Math.max(0, SESSION_PROMPT_CAP_BYTES - fixedBytes)
  const { items: keptArcs } = capArrayToJsonBytes(
    arcsSummary,
    Math.floor(available * 0.6),
    2,
  )
  const keptOrigins = new Set(keptArcs.map((a) => a.originId))
  const relevantRuns = result.stepRuns.filter(
    (sr) => keptOrigins.has(taskToOrigin.get(sr.taskId) ?? sr.taskId),
  )
  const { items: keptRuns } = capArrayToJsonBytes(
    relevantRuns,
    Math.floor(available * 0.4),
    2,
  )

  const note = `\n\n[PROMPT CAP: ${arcsSummary.length - keptArcs.length} of ${arcsSummary.length} arc summaries and ${result.stepRuns.length - keptRuns.length} of ${result.stepRuns.length} step records were dropped WHOLE to fit the ${Math.round(
    SESSION_PROMPT_CAP_BYTES / 1024,
  )}KB limit; every JSON document above is complete. Do NOT assume you saw the full session.]`
  return render(keptArcs, keptRuns, note)
}

/**
 * Run the session-scoped reflector against a Foreground session.
 *
 * Reuses the same JSON output schema as {@link runDeepReflectorArc} so that
 * {@link applyVerdicts} (and the fingerprint-dedup + proposal-landing path)
 * work unchanged.
 */
export const runSessionReflector = async (
  result: SessionArcsResult,
  timeoutMs: number = Number(process.env.MARS_DEEP_REFLECT_TIMEOUT_MS) || 10 * 60 * 1000,
): Promise<DeepReflectionResult> => {
  const model = process.env.MARS_DEEP_REFLECT_MODEL
  const r = await runHeadlessProvider(buildSessionPrompt(result), {
    cwd: getRepoRoot(),
    timeoutMs,
    ...(model !== undefined ? { model } : {}),
    modelTier: 'flagship',
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
  })
  const text = collectAssistantText(r.conversation) || r.stdout
  const report = parseDeepReflectionReport(text)
  return {
    report: report ?? emptyReport(),
    rawOutput: text,
    exitCode: r.exitCode,
  }
}
