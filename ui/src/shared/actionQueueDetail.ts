/**
 * Pure helpers for the actionQueue detail panel: trace-event payload summary
 * and severity styling, kept out of the React component so they can be
 * unit-tested without a render.
 *
 * The former failure-reason catalog helpers (lookup, action-op binding,
 * CLI-hint rendering) were removed with the code-keyed catalog (ADR-0042):
 * task-failure rows now render their reason and recovery menu directly from the
 * row's `body` and `actions` fields, derived daemon-side from the single
 * signature-keyed Failure kind record.
 */
import type { TraceEvent } from './schemas'
import { formatDuration } from './time'

/**
 * Convert a machine-readable failure signature / reason code into a short,
 * operator-readable phrase. This is the single client-side humanization
 * function for failure codes — both the Action Queue trace summary and the
 * Task Detail Drawer banner call it so the two surfaces can never drift.
 *
 * Examples:
 *   'verify:has-diff'  → 'has-diff (verify step)'
 *   'code:over-budget' → 'over-budget (code step)'
 *   'daemon-killed'    → 'daemon killed'
 *   'tool_timeout'     → 'tool timeout'
 */
export const humanizeFailureCode = (code: string): string => {
  const colonIdx = code.indexOf(':')
  if (colonIdx !== -1) {
    // 'verify:typecheck' → 'typecheck (verify step)'
    return `${code.slice(colonIdx + 1)} (${code.slice(0, colonIdx)} step)`
  }
  // 'tool_timeout' → 'tool timeout'
  return code.replace(/[_-]/g, ' ')
}

// ---------------------------------------------------------------------------
// Claude-event gist helpers (log_line payloads that carry a ClaudeEvent in
// their `fields` key). These are never exported — the public surface is
// summarizeTraceEvent.
// ---------------------------------------------------------------------------

const CLAUDE_EVENT_TYPES = new Set([
  'assistant',
  'user',
  'tool_use',
  'tool_result',
  'thinking_tokens',
  'system',
])

const CLAUDE_GIST_TRUNCATE = 60

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Produce a scannable one-liner from a claude-event fields object.
 * Handles the four shapes emitted by the Claude Code SDK:
 *   - assistant with tool_use content  → "→ ToolName: <short input>"
 *   - user/tool_result content         → "← result (N chars, ok|error)"
 *   - thinking_tokens / system         → "thinking (+N tokens)"
 *   - assistant with usage (no tools)  → "assistant turn (in N / out N / cache N)"
 */
const gistFromClaudeFields = (fields: Record<string, unknown>): string => {
  const type = typeof fields.type === 'string' ? fields.type : ''

  if (type === 'assistant') {
    const msg = fields.message
    if (isPlainObj(msg)) {
      const content = Array.isArray(msg.content) ? (msg.content as unknown[]) : []

      // Prefer tool_use gist: the turn invoked a tool.
      const toolUseBlock = content.find(
        (b): b is Record<string, unknown> => isPlainObj(b) && b.type === 'tool_use',
      )
      if (toolUseBlock) {
        const name = typeof toolUseBlock.name === 'string' ? toolUseBlock.name : 'tool'
        const input = toolUseBlock.input
        let desc = ''
        if (isPlainObj(input)) {
          // description field first (human-readable intent), then command (Bash input)
          desc =
            (typeof input.description === 'string' ? input.description : '') ||
            (typeof input.command === 'string' ? input.command : '')
        }
        const truncated =
          desc.length > CLAUDE_GIST_TRUNCATE
            ? `${desc.slice(0, CLAUDE_GIST_TRUNCATE)}…`
            : desc
        return `→ ${name}${truncated ? `: ${truncated}` : ''}`
      }

      // No tool_use: summarize token usage.
      const usage = msg.usage
      if (isPlainObj(usage)) {
        const inp = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
        const out = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
        const cache =
          typeof usage.cache_read_input_tokens === 'number'
            ? usage.cache_read_input_tokens
            : 0
        return `assistant turn (in ${inp} / out ${out} / cache ${cache})`
      }
    }
    return 'assistant'
  }

  if (type === 'user') {
    const msg = fields.message
    if (isPlainObj(msg)) {
      const content = Array.isArray(msg.content) ? (msg.content as unknown[]) : []
      const toolResultBlock = content.find(
        (b): b is Record<string, unknown> => isPlainObj(b) && b.type === 'tool_result',
      )
      if (toolResultBlock) {
        const c = toolResultBlock.content
        const chars =
          typeof c === 'string' ? c.length : (JSON.stringify(c)?.length ?? 0)
        return `← result (${chars} chars, ${toolResultBlock.is_error === true ? 'error' : 'ok'})`
      }
    }
    return 'user'
  }

  if (type === 'tool_result') {
    const c = fields.content
    const chars = typeof c === 'string' ? c.length : (JSON.stringify(c)?.length ?? 0)
    return `← result (${chars} chars, ${fields.is_error === true ? 'error' : 'ok'})`
  }

  if (type === 'thinking_tokens' || type === 'system') {
    const budget =
      typeof fields.budget_tokens === 'number' ? fields.budget_tokens : null
    return budget !== null ? `thinking (+${budget} tokens)` : 'thinking'
  }

  return type
}

/**
 * True when a log_line payload's `fields` object looks like a claude-event
 * (i.e. carries one of the known SDK event `type` values). Used to gate the
 * gist path in summarizeTraceEvent.
 */
const isClaudeEventFields = (fields: unknown): fields is Record<string, unknown> =>
  isPlainObj(fields) &&
  typeof (fields as Record<string, unknown>).type === 'string' &&
  CLAUDE_EVENT_TYPES.has((fields as Record<string, unknown>).type as string)

/**
 * Build a one-line summary of a trace event payload. Defers to the kind so
 * the Traces section reads more like a timeline than a JSON dump.
 *
 * Every line is a natural-language clause an operator can scan at a glance:
 * non-zero exits, failures, and blocks all read as short sentences rather than
 * raw telemetry fragments.
 */
export const summarizeTraceEvent = (event: TraceEvent): string => {
  const p = event.payload

  if (event.kind === 'step_started') {
    return typeof p.stepName === 'string' ? p.stepName : '(unknown step)'
  }

  if (event.kind === 'step_ended') {
    const name = typeof p.stepName === 'string' ? p.stepName : '(unknown step)'
    const raw = typeof p.outcome === 'string' ? p.outcome : null
    const outcome = raw === 'failure' ? 'failed' : raw === 'completed' ? 'completed' : (raw ?? 'ended')
    return `${name} step ${outcome}`
  }

  if (event.kind === 'tool_invoked') {
    const rawTool = typeof p.tool === 'string' ? p.tool : '(tool)'
    const tool = rawTool.includes('/') ? (rawTool.split('/').pop() || rawTool) : rawTool
    const argv = Array.isArray(p.argv) ? (p.argv as string[]).join(' ') : ''
    const cmd = argv ? `${tool} ${argv}` : tool
    const truncated = cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd
    const exitCode = typeof p.exitCode === 'number' ? p.exitCode : null
    if (exitCode !== null && exitCode !== 0) {
      return `${truncated} → exit ${exitCode}`
    }
    return truncated
  }

  if (event.kind === 'cli-invocation') {
    const command = typeof p.command === 'string' ? p.command : ''
    const exitCode = typeof p.exitCode === 'number' ? p.exitCode : null
    const dur = typeof p.durationMs === 'number' ? formatDuration(p.durationMs) : ''
    const parts = [`mars ${command}`]
    if (exitCode !== null && exitCode !== 0) parts.push(`→ exit ${exitCode}`)
    if (dur) parts.push(dur)
    return parts.join(' ')
  }

  if (event.kind === 'task_failed') {
    // Prefer human-readable prose; only fall through to the machine code when
    // no prose is available, and humanize even then.
    if (typeof p.failureReason === 'string') return p.failureReason
    if (typeof p.failureReasonCode === 'string') return humanizeFailureCode(p.failureReasonCode)
    return 'task failed'
  }

  if (event.kind === 'task_blocked') {
    const blockedBy =
      typeof p.blockerTaskId === 'string'
        ? p.blockerTaskId
        : Array.isArray(p.blockedBy)
          ? (p.blockedBy as unknown[]).filter((s) => typeof s === 'string').join(', ')
          : null
    return blockedBy ? `waiting on ${blockedBy}` : 'blocked'
  }

  if (event.kind === 'recovery_spawned') {
    const recoveryId =
      typeof p.recoveryTaskId === 'string' ? p.recoveryTaskId : null
    return recoveryId ? `recovery ${recoveryId}` : 'recovery spawned'
  }

  if (event.kind === 'origin_created') {
    return typeof p.source === 'string' ? `origin (${p.source})` : 'origin'
  }

  if (event.kind === 'log_line') {
    // When `fields` carries a claude-event object, produce a human gist
    // instead of returning the raw msg (which can be a long JSON dump).
    if (isClaudeEventFields(p.fields)) {
      return gistFromClaudeFields(p.fields)
    }
    return typeof p.msg === 'string' ? p.msg : '(no message)'
  }

  // Unknown kind — fall back to the kind name itself.
  return event.kind
}

/**
 * True when a trace event is a `mars` CLI invocation (a `tool_invoked` event
 * whose tool basename is exactly `mars`). The basename is taken so a
 * full-path tool (e.g. `/usr/local/bin/mars`) still matches, mirroring the
 * basename logic in {@link summarizeTraceEvent}.
 *
 * Mars calls are the operator-meaningful actions in a trace (enqueues,
 * action-queue raises, blocks) as opposed to the `git`/`npx` plumbing, so the
 * trace surfaces highlight them in blue. Centralised here so every trace
 * component (Action Queue, Events, Arc rail) applies the same rule.
 */
export const isMarsToolEvent = (event: TraceEvent): boolean => {
  if (event.kind !== 'tool_invoked') return false
  const raw = event.payload.tool
  if (typeof raw !== 'string') return false
  const tool = raw.includes('/') ? raw.split('/').pop() || raw : raw
  return tool === 'mars'
}

/**
 * Tailwind class that paints a `mars` trace row blue so it stands out from the
 * surrounding `git`/`npx` plumbing. Returns '' for non-mars events so callers
 * can interpolate it unconditionally. Severity (warn/error) coloring still
 * wins on its own spans; this tints the command summary text. The blue is the
 * scoped `--color-trace-mars` brand token (see styles/index.css), not a raw
 * Tailwind blue, so it stays themeable and on-system.
 */
export const marsToolTextClass = (event: TraceEvent): string =>
  isMarsToolEvent(event) ? 'text-trace-mars font-semibold' : ''

/**
 * Severity-to-tailwind color token used for the dot/badge next to each
 * trace event. Sticks to the existing palette (`iron`/`fg` + warn/err
 * accents from elsewhere in the codebase).
 */
export const severityColor = (severity: TraceEvent['severity']): string => {
  if (severity === 'error') return 'text-error'
  if (severity === 'warn') return 'text-warn'
  return 'text-iron/70'
}

/**
 * Severity-to-tailwind border+background token for trace-event rows.
 * WARN/ERROR rows get a tinted border and faint background so they stand
 * out from the surrounding INFO majority. INFO stays calm (existing neutral).
 *
 * Returns only the border-color and bg parts; the caller is responsible for
 * the `border` width utility (e.g. `border ${severityRowClass(s)}`).
 */
export const severityRowClass = (severity: TraceEvent['severity']): string => {
  if (severity === 'error') return 'border-error/40 bg-error/5'
  if (severity === 'warn') return 'border-warn/40 bg-warn/5'
  return 'border-iron/30 bg-iron/5'
}

/**
 * Human-readable labels for trace event kinds. Replaces raw machine keys
 * (step_started, tool_invoked) with scannable labels in the Events page.
 */
export const KIND_LABELS: Record<string, string> = {
  origin_created: 'Origin',
  step_started: 'Step start',
  step_ended: 'Step end',
  tool_invoked: 'Tool',
  task_blocked: 'Blocked',
  recovery_spawned: 'Recovery',
  task_failed: 'Failed',
  log_line: 'Log',
  'cli-invocation': 'CLI',
  scorer_result: 'Score',
  'worker-model-mismatch': 'Model mismatch',
}

export const humanizeKind = (kind: string): string =>
  KIND_LABELS[kind] ?? kind.replace(/[_-]/g, ' ')

/**
 * Human-readable labels for workflow phases.
 */
export const PHASE_LABELS: Record<string, string> = {
  setup: 'Setup',
  code: 'Code',
  verify: 'Verify',
  merge: 'Merge',
}

export const humanizePhase = (phase: string | null): string | null => {
  if (phase === null) return null
  return PHASE_LABELS[phase] ?? phase
}

/**
 * One-line "why now" subtitle — the most actionable reason an operator should
 * act on a task-failure card. Priority: diagnosis text → errorKind (when
 * distinct from kind) → failureReasonCode → arc reason → body first line
 * (when non-generic).
 */
export function whyNowText(item: { diagnosis?: { text: string } | null | undefined; errorKind: string; kind: string; failureReasonCode?: string | null; body: string; reason?: string }): string | null {
  if (item.diagnosis?.text) {
    const line = item.diagnosis.text.split('\n')[0]
    return line.length > 100 ? `${line.slice(0, 100)}…` : line
  }
  if (item.errorKind && item.errorKind !== item.kind) {
    return humanizeFailureCode(item.errorKind)
  }
  if (item.failureReasonCode) {
    return humanizeFailureCode(item.failureReasonCode)
  }
  if (item.kind === 'arc-failed' && item.reason) {
    const line = item.reason.split('\n')[0]
    return line.length > 100 ? `${line.slice(0, 100)}…` : line
  }
  if (item.body) {
    const line = item.body.split('\n')[0]
    const GENERIC_BODY =
      'A pipeline step did not complete. See the transcript for details.'
    if (line.length === 0 || line === GENERIC_BODY) return null
    return line.length > 100 ? `${line.slice(0, 100)}…` : line
  }
  return null
}

/** Kinds the UI labels distinctly in the Origins tree badge. */
export const originKindLabel = (kind: string): string => {
  if (kind === 'proposal') return 'PROPOSAL'
  if (kind === 'prd') return 'PRD'
  if (kind === 'fix') return 'FIX'
  return 'TASK'
}

/**
 * Short display label for an action-queue row kind. Used in both the sidebar
 * row kind badge and the detail panel header badge so the label is authoritative
 * in one place for raw daemon kinds.
 */
export const kindBadgeLabel = (kind: string): string => {
  if (kind === 'arc-failed') return 'arc failed'
  if (kind === 'failed') return 'failed'
  if (kind === 'stale-worktree') return 'stale wt'
  if (kind === 'draft-proposal') return 'draft'
  if (kind === 'awaiting-validation') return 'validate'
  return kind
}
