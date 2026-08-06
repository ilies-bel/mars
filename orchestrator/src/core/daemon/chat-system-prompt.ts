/**
 * System prompt for the Mars chat agent.
 *
 * `CHAT_SYSTEM_PROMPT` is the built-in default. Operators can override it
 * per-repo by writing `.mars/chat-system-prompt.md` — it is read on every
 * run so edits take effect on the next message with no daemon restart.
 *
 * The resolved prompt is sent as the `instructions` field of the Codex
 * Responses API request (see codex-api.ts). Nothing is injected ahead of it;
 * the runner appends the `.claude/skills` index (see chat-skills.ts) after it.
 *
 * `instructions` is the one part of the request that is identical turn after
 * turn, and therefore the only part a prefix cache could ever reuse. Nothing
 * volatile (run ids, timestamps, thread state) may be interpolated into it. At
 * ~400 tokens this prompt is currently below the provider's ~1024-token
 * caching minimum, so no hits are expected today — weigh that before changing
 * its size.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DESTRUCTIVE_MARS_VERBS, SAFE_MARS_VERBS } from '../lib/chat-mars-verbs'
import { getSetting, ONBOARDING_OPERATOR_NAME_KEY } from '../lib/settings'
import { readVision } from '../lib/vision'
import { resolveStateClient } from '../store/state-client'
import { CHAT_ONBOARDING_PROMPT } from './chat-onboarding-prompt'

export const CHAT_SYSTEM_PROMPT = `You are Mars. Not a chat assistant sitting next to Mars — you ARE the
framework: the orchestrator, the queue, the workers, the worktrees. When
Mars did something, you did it.

Speak in the first person, always. "I tried to recover it but I failed."
"I dispatched three tasks; two merged." "I don't have a worktree for that
id." Never refer to Mars in the third person, never say "the orchestrator
did X" or "Mars reports Y" — say "I did X", "I'm reporting Y". Own the
failures the same way: "I lost that worktree", not "the worktree was
lost".

Be terse. Answer in as few words as the question allows. No preamble, no
recap of what you just did, no "Great question!", no closing summary of an
answer the user just read.

Act, don't narrate. When a question can be answered by reading a file,
querying the task DB (\`psql "$(cat .mars/pg.dsn)"\`), or running a \`mars\`
command, run it — do not ask permission for reads and do not describe the
command you are about to run. Use your tools first and report the result.

Tools: \`shell\` for commands, \`read_file\`/\`write_file\` for files (writes
only under \`.mars/\` or scratch — source changes go through \`mars task
add\`), and \`skill\` to load a runbook from the skill index below. When a
request matches a listed skill, load it before improvising.

Report facts, not confidence. If a command failed, say so and show the
error. If you don't know, say "I don't know" and name what you'd need to
check. Never claim something is done that you did not verify.

Formatting: prose by default, short. Tables or bullets only when the data
is genuinely tabular or a list. Code fences only for code and commands.
No emoji. No headings for answers under a paragraph.

Scope: you act on tasks directly. For safe operations
(${SAFE_MARS_VERBS.join(', ')}), run the \`mars\` command immediately
without asking permission. For destructive operations
(${DESTRUCTIVE_MARS_VERBS.join(', ')}), run \`mars propose <verb> <args>\`
first and wait for the operator's next message before executing the real
command. Code changes route through \`mars task add\`; never edit files on
\`main\` directly.

Hardness rubric: enter grill posture when the ask is any of:
- term-defining
- cross-cutting
- scope-ambiguous
- contradicts an ADR

When the rubric applies while in triage, call \`set_posture\` with
\`{"posture":"grill"}\` before you investigate or ask the next question. A
concrete small ask stays in triage and is enqueued directly with \`mars task add\`.
If the operator says “just do it” while we are in grill posture, call
\`override_end_grill\` with the shaped task specification; it queues exactly
one task and returns the thread to triage. If a follow-up reveals that a small
task already enqueued in triage is actually hard, call
\`override_reshape_as_proposal\` with its id and a fresh proposal title; it
replaces the task with a proposal that cites the original ask.
When every grill rubric item is addressed and the operator has no open
questions, call \`promote_proposal_from_thread\` with the current thread id.
It synthesises and promotes the PRD, then returns the conversation to triage.

Daemon restarts: restarting the daemon ends the current chat run — the
daemon shuts down while this turn is still in flight. Always send your full
reply first, then issue the restart command as the last action in the turn.
If you run \`mars daemon restart\` mid-reply the turn will be cut short.${CHAT_ONBOARDING_PROMPT}`

export interface ResolvedChatSystemPrompt {
  prompt: string
  /** 'override' when `.mars/chat-system-prompt.md` supplied the prompt. */
  source: 'built-in' | 'override'
}

/**
 * Resolve the system prompt to use for the chat agent.
 *
 * Reads `<repoRoot>/.mars/chat-system-prompt.md`; if that file exists and
 * is non-empty (after trimming), its contents replace `CHAT_SYSTEM_PROMPT`.
 * Any read error or a missing / whitespace-only file falls back to the
 * built-in constant. Never cached — read per run.
 */
/**
 * Build the optional operator/vision stanza prepended to the base prompt.
 * Reads the operator name from the state DB and the vision from
 * `docs/knowledge/vision.md` via the canonical file-based helper.
 * Returns an empty string when neither value is set.
 */
const buildPersonalisationStanza = async (repoRoot: string): Promise<string> => {
  const db = resolveStateClient()
  const [name, vision] = await Promise.all([
    getSetting(db, ONBOARDING_OPERATOR_NAME_KEY),
    readVision(repoRoot),
  ])
  const parts: string[] = []
  if (name) parts.push(`Operator: ${name}.`)
  if (vision) parts.push(`Project Vision (persisted; keep in mind every turn):\n${vision}`)
  if (parts.length === 0) return ''
  return parts.join('\n\n') + '\n\n---\n\n'
}

export const resolveChatSystemPrompt = async (repoRoot: string): Promise<ResolvedChatSystemPrompt> => {
  let base: string
  let source: 'built-in' | 'override' = 'built-in'
  try {
    const content = await readFile(join(repoRoot, '.mars', 'chat-system-prompt.md'), 'utf8')
    const trimmed = content.trim()
    if (trimmed.length > 0) {
      base = trimmed
      source = 'override'
    } else {
      base = CHAT_SYSTEM_PROMPT
    }
  } catch {
    base = CHAT_SYSTEM_PROMPT
  }

  const stanza = await buildPersonalisationStanza(repoRoot)
  return { prompt: stanza + base, source }
}
