/**
 * Rescue-operator Worker: system prompt, verdict type, and runner.
 *
 * The rescue-operator is the court of last resort for a dead-ended Arc.
 * It carries a pinned system prompt that names exactly three permitted
 * corrective actions and forbids all others.
 *
 * runRescueOperator drives an injected Worker, accumulates the agent's
 * text output via the onEvent stream, and returns a structured RescueVerdict.
 * Callers must pass the Worker explicitly (pass Workers.RescueOperator in
 * production, a mock in tests) to avoid circular-import issues.
 */

import type { AgentEvent } from '../lib/claude-stream'
import { readWorkerOutputText } from '../lib/worker-json'
import type { Task } from '../queue'
import type { Worker } from '.'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RescueVerdict = {
  readonly action: 'restart' | 'continue' | 'supersede' | 'no-action-needed'
  readonly reasoning: string
  readonly supersedePrompt?: string
}

// ---------------------------------------------------------------------------
// Pinned system prompt (the full audit-visible posture for this Worker)
// ---------------------------------------------------------------------------

/**
 * System prompt pinned for the RescueOperator Worker.
 *
 * Lists exactly the three permitted corrective actions (restart, continue,
 * supersede) and explicitly forbids any other mutation. The agent emits a
 * JSON verdict as its last output line so runRescueOperator can parse the
 * result without reaching into internal state.
 */
export const RESCUE_OPERATOR_SYSTEM_PROMPT =
  'You are a rescue-operator agent. An Arc has dead-ended — either the ' +
  'original failure had no automatic fix recipe, or the recovery attempt ' +
  'itself failed. Your role is to choose EXACTLY ONE action from the list ' +
  'below and execute it.\n' +
  '\n' +
  '## Step 0 (MANDATORY — do this before anything else)\n' +
  '\n' +
  'Run `mars show <origin-id>` to check the arc origin\'s LIVE status. ' +
  'The arc member statuses in the prompt are a stale snapshot captured ' +
  'when the arc dead-ended; the arc may have self-resolved by the time ' +
  'you run. If the origin task is now `done`, OR every arc member is ' +
  'terminal in a non-`failed` state, the work has already been completed ' +
  'without your intervention. In that case you MUST choose ' +
  '`no-action-needed` — do NOT run restart/continue/supersede.\n' +
  '\n' +
  '## Permitted actions (choose exactly one)\n' +
  '\n' +
  '0. **no-action-needed** — Emit the verdict below and exit immediately.\n' +
  '   REQUIRED when the origin task is now `done` or every arc member is ' +
  'terminal in a non-`failed` state (the arc has self-resolved). Include ' +
  'the resolving evidence — the task status, and the merge commit sha from ' +
  'the worktree tombstone (`.mars/worktrees/<task-id>.removed.json`) if ' +
  'present — in `reasoning`.\n' +
  '\n' +
  '1. **restart** — Run `mars restart <task-id>`.\n' +
  '   Use when the failure appears transient (flaky test, environment ' +
  'issue, temporary resource limit) and a fresh run from scratch is ' +
  'likely to succeed.\n' +
  '\n' +
  '2. **continue** — Run `mars continue <task-id>`.\n' +
  '   Use when the worktree contains salvageable partial work and ' +
  'resuming from the existing worktree is the right approach.\n' +
  '\n' +
  '3. **supersede** — Run `mars task add --supersede <task-id> "<new prompt>"`.\n' +
  '   Use when the original task\'s prompt was wrong, unclear, or the ' +
  'approach was fundamentally flawed. The new task automatically ' +
  'inherits the Arc\'s origin_id.\n' +
  '\n' +
  '## Forbidden actions\n' +
  '\n' +
  '- Do NOT run `mars task add` without the `--supersede` flag.\n' +
  '- Do NOT spawn additional rescue, recovery, or investigator tasks.\n' +
  '- Do NOT run `mars proposal`, `mars draft`, or any other backlog-mutation command.\n' +
  '- Do NOT create, edit, or commit ANY file — not a markdown note, not a ' +
  'README, not a scratch file, nothing. This applies everywhere: the repo ' +
  'root, `docs/`, `docs/notes/`, `docs/context-notes/`, `docs/unblock-notes/`, ' +
  'anywhere. There is no assessment-note convention for this Worker. The ' +
  '`reasoning` field in the JSON verdict below is your ONLY output surface ' +
  'for analysis — it is already persisted (recordStewardIntervention), so a ' +
  'separate file is redundant duplication, not a backup.\n' +
  '- Do NOT take any action beyond the four listed above.\n' +
  '\n' +
  '## Process\n' +
  '\n' +
  '1. Run `mars show <origin-id>` — check live status FIRST (Step 0 above).\n' +
  '2. If the arc has self-resolved: emit `no-action-needed` and exit.\n' +
  '3. Otherwise: read the failed task\'s failure signature and reason from ' +
  'the prompt, inspect the worktree (`git log`, `git status`, verify output), ' +
  'choose ONE of actions 1–3 and execute it.\n' +
  '4. After executing, emit a JSON verdict as the LAST line of your output. ' +
  'Put your full assessment — what went wrong, what you inspected, why you ' +
  'picked this action — into `reasoning`; it is the only place that record ' +
  'lives, so write it as the complete note, not a summary of a note filed ' +
  'elsewhere:\n' +
  '   - no-action-needed: `{"action":"no-action-needed","reasoning":"<evidence: origin done, merged as <sha> / status=<status>>"}`\n' +
  '   - restart:          `{"action":"restart","reasoning":"<why>"}`\n' +
  '   - continue:         `{"action":"continue","reasoning":"<why>"}`\n' +
  '   - supersede:        `{"action":"supersede","reasoning":"<why>","supersedePrompt":"<the prompt you passed to mars task add --supersede>"}`\n'

// ---------------------------------------------------------------------------
// Denied tools (belt-and-suspenders on top of the system-prompt constraint)
// ---------------------------------------------------------------------------

/**
 * Tools denied at the Worker layer for the rescue-operator.
 * Blocks the most dangerous backlog-mutation commands that fall outside
 * the three permitted corrective actions, plus any file mutation and any
 * `git commit` — the agent's sole output is the JSON verdict text, never a
 * committed file. The system prompt is the primary enforcement mechanism;
 * this list is an additional, mechanically-enforced guard.
 *
 * `Edit`, `Write` and `NotebookEdit` are bare tool names, matching the form
 * `READ_ONLY_DENIED_TOOLS` already uses for
 * Planner/Slicer/Triager/BehaviourVerifier/Scorer. The two providers honour
 * that form very differently:
 *
 * - claude: `spawnArgv` passes the list straight through as
 *   `--disallowedTools Edit,Write,…`, matching on exact tool name (the
 *   `Bash(git commit*)` entry matches on command prefix in the same flag).
 *   This is a genuine, mechanically-enforced block at the tool-call layer,
 *   independent of sandbox mode.
 * - codex (the current global default): `isReadOnlyRun` in
 *   `providers/codex-headless.ts` normally tests for `Edit` AND `Write` in
 *   this list and, when both are present, spawns `codex exec` with
 *   `--sandbox read-only` instead of `workspace-write` — codex has no
 *   per-tool deny mechanism, so the OS sandbox is its only enforcement
 *   surface. For THIS Worker specifically, the RescueOperator's own
 *   `WorkerConfig` in `index.ts` pins `forceSandbox: 'workspace-write'`,
 *   which `isReadOnlyRun` honours ahead of the `disallowedTools`-derived
 *   default. That override exists because `--sandbox read-only` was
 *   verified empirically to break the `mars` CLI itself (a tsx wrapper
 *   that opens a local IPC pipe under `$TMPDIR` at startup — denied
 *   outright by codex's read-only sandbox, so even `mars --version` fails
 *   with `EPERM`), which would make this Worker a silent total no-op: it
 *   could never execute any of its three permitted actions. On codex,
 *   file-write prevention for this Worker therefore rests on the system
 *   prompt above (forbidding ANY file mutation) rather than the OS sandbox
 *   — codex exposes no narrower policy that keeps `/tmp` writable while
 *   blocking writes to the repo (`sandbox_workspace_write.writable_roots`
 *   cannot exclude the primary workspace root; verified empirically).
 *
 * Keep `Edit` and `Write` together regardless: `isReadOnlyRun`'s
 * `disallowedTools`-derived fallback (used by every OTHER Worker sharing
 * this list shape) requires BOTH, so dropping either one would silently
 * return those Workers' codex runs to `workspace-write` and un-enforce
 * their read-only posture.
 */
export const RESCUE_OPERATOR_DENIED_TOOLS: readonly string[] = [
  'Bash(mars proposal*)',
  'Bash(mars draft*)',
  'Bash(mars task add --blocked-by*)',
  'Bash(git commit*)',
  'Write',
  'Edit',
  'NotebookEdit',
] as const

// ---------------------------------------------------------------------------
// Prompt builder (called by maybeSpawnRescueOperator at enqueue time)
// ---------------------------------------------------------------------------

/**
 * The rescue task is triaged by Workers.Triager before Workers.RescueOperator
 * ever receives it. Keep its user prompt comfortably below Triager's 50k
 * context budget, leaving room for the triage system prompt and tool output.
 * This is an estimate rather than a provider tokenizer count; the bounded
 * fields below make the actual assembled prompt far smaller in practice.
 */
export const RESCUE_TRIAGE_PROMPT_TOKEN_BUDGET = 40_000

const CHARS_PER_TOKEN = 4
const MAX_ARC_MEMBERS_IN_PROMPT = 10
const MAX_MEMBER_ID_CHARS = 256
const MAX_FAILURE_SIGNATURE_CHARS = 500
const MAX_FAILURE_REASON_CHARS = 2_000

type RescueArcMember = Pick<
  Task,
  'id' | 'status' | 'failureSignature' | 'failureReason' | 'createdAt'
> & {
  /** Accepted solely to make it explicit that raw prompts are never rendered. */
  readonly prompt?: string
}

interface RescueOperatorPromptInput {
  failedTaskId: string
  originId: string
  failureSignature: string
  arcMembers: readonly RescueArcMember[]
}

const boundedText = (value: string | null | undefined, limit: number): string => {
  const text = (value ?? '(none)').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…[truncated]`
}

export const estimateRescueTriagePromptTokens = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN)

/**
 * Build the per-invocation user prompt for a rescue-operator task.
 * Called by maybeSpawnRescueOperator when enqueueing the rescue task.
 *
 * The task will first pass through the 50k-token Triager. To keep that
 * boundary safe, include only deterministic, bounded arc summaries — never
 * raw task prompts or transcripts. Members are newest-first so a budgeted
 * view retains the most recent failure evidence.
 */
export const buildRescueOperatorPrompt = (input: RescueOperatorPromptInput): string => {
  const members = [...input.arcMembers]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, MAX_ARC_MEMBERS_IN_PROMPT)
  const omittedMembers = Math.max(0, input.arcMembers.length - members.length)
  const prompt =
    `[rescue-operator] Arc ${boundedText(input.originId, MAX_MEMBER_ID_CHARS)} has dead-ended.\n` +
    `Failed task: ${boundedText(input.failedTaskId, MAX_MEMBER_ID_CHARS)}\n` +
    `Failure signature: ${boundedText(input.failureSignature, MAX_FAILURE_SIGNATURE_CHARS)}\n\n` +
    `Arc context is partial: ${omittedMembers} older members omitted. ` +
    `Members below are newest first and contain structured failure summaries only. ` +
    `Raw task prompts and transcripts are not inlined; inspect a task id or its worktree selectively if needed.\n\n` +
    `STALE SNAPSHOT WARNING: the statuses below were captured when the arc dead-ended and may ` +
    `be out of date by dispatch time. Before choosing an action, re-read live state for every id ` +
    `you are about to act on: \`mars show <id>\` (status, branch, worktree) and ` +
    `\`git rev-list --count main..<branch>\` (is anything actually ahead?). A missing worktree ` +
    `silently degrades \`continue\` into a destructive \`restart\`.\n\n` +
    `Arc members (id | status | failure_signature | failure_reason):\n` +
    (members.length === 0
      ? '(no persisted arc members found)\n'
      : members
          .map(
            (member) =>
              `${boundedText(member.id, MAX_MEMBER_ID_CHARS)} | ${boundedText(member.status, 64)} | ` +
              `${boundedText(member.failureSignature, MAX_FAILURE_SIGNATURE_CHARS)} | ` +
              `${boundedText(member.failureReason, MAX_FAILURE_REASON_CHARS)}`,
          )
          .join('\n') + '\n') +
    `\nBefore choosing any action, run \`mars show ${boundedText(input.originId, MAX_MEMBER_ID_CHARS)}\` to re-read ` +
    `live status — the arc may have self-resolved since this prompt was built. ` +
    `If the origin is now \`done\`, emit \`no-action-needed\` immediately. ` +
    `Otherwise inspect the task, worktree, and git history, then choose and ` +
    `execute exactly one of the four permitted actions ` +
    `(no-action-needed, restart, continue, or supersede). ` +
    `Emit the JSON verdict as the last line of your output.`

  const estimatedTokens = estimateRescueTriagePromptTokens(prompt)
  if (estimatedTokens > RESCUE_TRIAGE_PROMPT_TOKEN_BUDGET) {
    throw new Error(
      `rescue-operator triage prompt for arc ${input.originId} remains over budget ` +
        `after truncation: ${estimatedTokens}/${RESCUE_TRIAGE_PROMPT_TOKEN_BUDGET} estimated tokens`,
    )
  }
  return prompt
}

// ---------------------------------------------------------------------------
// Verdict parser
// ---------------------------------------------------------------------------

/**
 * Parse a RescueVerdict from the agent's accumulated text output.
 * Scans lines in reverse for the last JSON object with a valid 'action'
 * field (restart | continue | supersede) and a 'reasoning' string.
 * Returns null when no valid verdict is found.
 */
export const parseRescueVerdict = (text: string): RescueVerdict | null => {
  const lines = text.split('\n').reverse()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const p = parsed as Record<string, unknown>
    if (
      (p.action === 'restart' ||
        p.action === 'continue' ||
        p.action === 'supersede' ||
        p.action === 'no-action-needed') &&
      typeof p.reasoning === 'string'
    ) {
      return {
        action: p.action,
        reasoning: p.reasoning,
        supersedePrompt: typeof p.supersedePrompt === 'string' ? p.supersedePrompt : undefined,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Injectable checker: resolves the current live status of the arc's origin
 * task BEFORE the rescue Worker is invoked. When the origin has already
 * reached `done` (or every member is terminal in a non-`failed` state), the
 * checker returns `{ resolved: true }` with a human-readable evidence string
 * (e.g. the merge sha from the worktree tombstone) so `runRescueOperator`
 * can short-circuit with a `no-action-needed` verdict without ever calling
 * `worker.run()`.
 *
 * In production, inject a function that calls `store.getTask(originId)` and
 * reads the tombstone at `.mars/worktrees/<originId>.removed.json`. In tests,
 * inject a stub that returns the desired outcome deterministically.
 */
export type OriginResolvedChecker = (
  originId: string,
) => Promise<{ resolved: true; evidence: string } | { resolved: false }>

/**
 * Run the rescue-operator Worker for a given rescue task and return a
 * structured RescueVerdict describing which corrective action the agent took.
 *
 * The `task` parameter is the rescue-operator task row itself (tagged
 * 'rescue-operator'), whose `prompt` field already contains the failure
 * context built by buildRescueOperatorPrompt. The Worker is injected so
 * tests can pass a lightweight mock without spawning a real claude process.
 *
 * @param task                      The rescue-operator task (prompt already built).
 * @param options.worker            The Worker to run (pass Workers.RescueOperator in
 *                                  production; a mock in tests).
 * @param options.cwd               Working directory. Defaults to task.worktreePath
 *                                  when present, then process.cwd() as a last resort.
 * @param options.originId          Arc origin task id. When provided together with
 *                                  `checkOriginResolved`, a live-state probe runs
 *                                  BEFORE the worker — if the origin is already done,
 *                                  returns `no-action-needed` immediately without
 *                                  calling `worker.run()`.
 * @param options.checkOriginResolved  Injectable origin-status checker (see
 *                                  {@link OriginResolvedChecker}). Only consulted
 *                                  when `originId` is also provided.
 */
export const runRescueOperator = async (
  task: Pick<Task, 'id' | 'prompt' | 'worktreePath'>,
  options: {
    worker: Worker
    cwd?: string
    originId?: string
    checkOriginResolved?: OriginResolvedChecker
  },
): Promise<RescueVerdict> => {
  const { worker } = options
  const cwd = options.cwd ?? task.worktreePath ?? process.cwd()

  // Pre-run short-circuit: if the caller supplied both an originId and a
  // live-state checker, probe the arc's current status before invoking the
  // Worker. When the arc has already self-resolved (origin `done`, or every
  // member terminal in a non-`failed` state), return `no-action-needed`
  // immediately — no Worker spawn, no alert raised. This closes the race
  // between spawn time and dispatch time that the setup-worktree guard
  // cannot cover (2026-09-07: mars-87b7c958 rescued an already-merged arc).
  if (options.originId && options.checkOriginResolved) {
    const precheck = await options.checkOriginResolved(options.originId)
    if (precheck.resolved) {
      return { action: 'no-action-needed', reasoning: precheck.evidence }
    }
  }

  // Accumulate text content emitted by the agent across all assistant turns.
  const textChunks: string[] = []

  const result = await worker.run(task.prompt, {
    cwd,
    onEvent: (event: AgentEvent) => {
      if (event.type !== 'assistant') return
      const msg = (event as Record<string, unknown>).message
      if (typeof msg !== 'object' || msg === null) return
      const content = (msg as Record<string, unknown>).content
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          (block as Record<string, unknown>).type === 'text' &&
          typeof (block as Record<string, unknown>).text === 'string'
        ) {
          textChunks.push((block as Record<string, unknown>).text as string)
        }
      }
    },
  })

  // Prefer verdict from the live event stream, then re-read complete stdout
  // through this Worker's configured provider adapter.
  const verdict =
    parseRescueVerdict(textChunks.join('\n')) ??
    parseRescueVerdict(readWorkerOutputText(worker.config.provider, result.stdout ?? '') ?? '')

  if (verdict === null) {
    throw new Error(
      `rescue-operator for task ${task.id} did not emit a valid RescueVerdict JSON` +
        `; exitCode=${result.exitCode}`,
    )
  }

  return verdict
}
