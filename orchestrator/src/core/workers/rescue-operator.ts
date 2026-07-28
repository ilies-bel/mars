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

import type { ClaudeEvent } from '../lib/claude-stream'
import type { Task } from '../queue'
import type { Worker } from '.'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RescueVerdict = {
  readonly action: 'restart' | 'continue' | 'supersede'
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
  'itself failed. Your role is to choose EXACTLY ONE corrective action ' +
  'from the list below and execute it.\n' +
  '\n' +
  '## Permitted actions (choose exactly one)\n' +
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
  '- Do NOT take any action beyond the three listed above.\n' +
  '\n' +
  '## Process\n' +
  '\n' +
  '1. Read the failed task\'s failure signature and reason from the prompt.\n' +
  '2. Inspect the worktree: check `git log`, `git status`, and any ' +
  'verify or error output left in the branch.\n' +
  '3. Choose ONE action from the list above and execute it.\n' +
  '4. After executing, emit a JSON verdict as the LAST line of your output:\n' +
  '   - restart:   `{"action":"restart","reasoning":"<why>"}`\n' +
  '   - continue:  `{"action":"continue","reasoning":"<why>"}`\n' +
  '   - supersede: `{"action":"supersede","reasoning":"<why>","supersedePrompt":"<the prompt you passed to mars task add --supersede>"}`\n'

// ---------------------------------------------------------------------------
// Denied tools (belt-and-suspenders on top of the system-prompt constraint)
// ---------------------------------------------------------------------------

/**
 * Tools denied at the Worker layer for the rescue-operator.
 * Blocks the most dangerous backlog-mutation commands that fall outside
 * the three permitted corrective actions. The system prompt is the
 * primary enforcement mechanism; this list is an additional guard.
 */
export const RESCUE_OPERATOR_DENIED_TOOLS: readonly string[] = [
  'Bash(mars proposal*)',
  'Bash(mars draft*)',
  'Bash(mars task add --blocked-by*)',
] as const

// ---------------------------------------------------------------------------
// Prompt builder (called by maybeSpawnRescueOperator at enqueue time)
// ---------------------------------------------------------------------------

/**
 * Build the per-invocation user prompt for a rescue-operator task.
 * Called by maybeSpawnRescueOperator when enqueueing the rescue task.
 * The failure context is embedded here so the agent has it in its
 * initial turn without needing to fetch it separately.
 */
export const buildRescueOperatorPrompt = (
  failedTaskId: string,
  originId: string,
  failureSignature: string,
): string =>
  `[rescue-operator] Arc ${originId} has dead-ended.\n` +
  `Failed task: ${failedTaskId}\n` +
  `Failure signature: ${failureSignature}\n\n` +
  `Inspect the task, worktree, and git history, then choose and execute ` +
  `exactly one of the three permitted actions (restart, continue, or supersede). ` +
  `Emit the JSON verdict as the last line of your output.`

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
      (p.action === 'restart' || p.action === 'continue' || p.action === 'supersede') &&
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
 * Run the rescue-operator Worker for a given rescue task and return a
 * structured RescueVerdict describing which corrective action the agent took.
 *
 * The `task` parameter is the rescue-operator task row itself (tagged
 * 'rescue-operator'), whose `prompt` field already contains the failure
 * context built by buildRescueOperatorPrompt. The Worker is injected so
 * tests can pass a lightweight mock without spawning a real claude process.
 *
 * @param task            The rescue-operator task (prompt already built).
 * @param options.worker  The Worker to run (pass Workers.RescueOperator in
 *                        production; a mock in tests).
 * @param options.cwd     Working directory. Defaults to task.worktreePath
 *                        when present, then process.cwd() as a last resort.
 */
export const runRescueOperator = async (
  task: Pick<Task, 'id' | 'prompt' | 'worktreePath'>,
  options: { worker: Worker; cwd?: string },
): Promise<RescueVerdict> => {
  const { worker } = options
  const cwd = options.cwd ?? task.worktreePath ?? process.cwd()

  // Accumulate text content emitted by the agent across all assistant turns.
  const textChunks: string[] = []

  const result = await worker.run(task.prompt, {
    cwd,
    onEvent: (event: ClaudeEvent) => {
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

  // Prefer verdict from the event stream; fall back to raw stdout for providers
  // that write text output there (e.g. Gemini, Codex headless adapters).
  const verdict =
    parseRescueVerdict(textChunks.join('\n')) ??
    parseRescueVerdict(result.stdout ?? '')

  if (verdict === null) {
    throw new Error(
      `rescue-operator for task ${task.id} did not emit a valid RescueVerdict JSON` +
        `; exitCode=${result.exitCode}`,
    )
  }

  return verdict
}
