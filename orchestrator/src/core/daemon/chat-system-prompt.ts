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
 *
 * ## Domain Flow contract
 *
 * Two sections are appended to the base prompt via exported stanza constants:
 *
 * - `DOMAIN_FLOW_AUTHORING_STANZA` — teaches the agent how to produce a
 *   Domain Flow during Arc planning. Consumed by the "Chat system prompt —
 *   Domain Flow authoring instructions" slice.
 * - `DOMAIN_FLOW_USER_STORY_STANZA` — teaches the agent how to derive user
 *   stories from an existing Domain Flow. Consumed by the "Chat prompt — user
 *   story derivation from Domain Flow" slice.
 *
 * The shared TypeScript types (`DomainEvent`, `DomainPolicy`,
 * `DomainFlowStep`, `DomainFlow`) live here so both consumer slices import
 * from a single canonical location.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DESTRUCTIVE_MARS_VERBS, SAFE_MARS_VERBS } from '../lib/chat-mars-verbs'
import { getSetting, ONBOARDING_OPERATOR_NAME_KEY } from '../lib/settings'
import { readVision } from '../lib/vision'
import { resolveStateClient } from '../store/state-client'
import { CHAT_ONBOARDING_INTERVIEW_STANZA, CHAT_ONBOARDING_PROMPT } from './chat-onboarding-prompt'

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

Triage investigations: for any question about the action queue ("what needs
me", "walk me through the N items", "what's pending"), run
\`mars action-queue list\` exactly once — it is the authoritative snapshot
and its count matches the sidebar badge. If the badge showed a different
number than the list, the extra row was a draft-proposal cluster: the UI
includes it, the CLI excludes it by default (fetch it separately with
\`--kind draft-proposal\`). Answer from the list snapshot; drill into
individual items only when the operator asks about a specific one.

Hardness rubric: enter grill posture when the ask is any of:
- term-defining
- cross-cutting
- scope-ambiguous
- contradicts an ADR

When the rubric applies while in triage, call \`set_posture\` with
\`{"posture":"grill"}\` before you investigate or ask the next question.
After calling set_posture, do not announce the transition. Never emit 'System:' prefixes or narrate your internal state to the operator. Begin grilling immediately with the first substantive challenge — the operator learns you entered grill posture from the quality of your questions, not from a declaration.
A concrete small ask stays in triage and is enqueued directly with \`mars task add\`.
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
If you run \`mars daemon restart\` mid-reply the turn will be cut short.`

// ---------------------------------------------------------------------------
// Domain Flow — shared type contract
// ---------------------------------------------------------------------------

/**
 * A named business occurrence that something in the system produced.
 *
 * Convention: PascalCase verb-noun, e.g. "TaskEnqueued", "WorkerAssigned".
 */
export interface DomainEvent {
  /** PascalCase verb-noun, e.g. "TaskEnqueued". */
  name: string
  /** One sentence: what happened and what it signals to the domain. */
  description: string
}

/**
 * A named rule that reacts to one or more Domain Events and produces a
 * side-effect or state transition.
 *
 * Convention: PascalCase noun-phrase, e.g. "DispatchGate", "RetryBudget".
 */
export interface DomainPolicy {
  /** PascalCase noun-phrase, e.g. "DispatchGate". */
  name: string
  /** Domain Event name(s) that trigger this policy. */
  triggeredBy: string[]
  /** What the policy does in response. */
  action: string
}

/** One step in a Domain Flow — either an event or a policy. */
export type DomainFlowStep =
  | { type: 'event'; event: DomainEvent }
  | { type: 'policy'; policy: DomainPolicy }

/**
 * The full Domain Flow artifact for one Arc.
 *
 * A Domain Flow is the named, ordered sequence of Domain Events and Domain
 * Policies that describes the business behaviour a change alters. It is
 * produced during an Arc's planning phase so the operator can steer domain
 * impact at planning time rather than discovering it in the diff.
 */
export interface DomainFlow {
  /** Short title identifying the flow, e.g. "Task dispatch cycle". */
  title: string
  /** One-paragraph summary of the business process being described. */
  summary: string
  /** Ordered sequence of events and policies; keep to ≤ 10 steps. */
  steps: DomainFlowStep[]
}

// ---------------------------------------------------------------------------
// Domain Flow authoring stanza
// (consumed by: "Chat system prompt — Domain Flow authoring instructions")
// ---------------------------------------------------------------------------

/**
 * Instruction stanza that teaches the chat agent how to produce a Domain Flow
 * during Arc shaping / grill posture.
 *
 * Append to the base system prompt so the agent can author a Domain Flow when
 * a proposal or Arc involves a significant change to business behaviour.
 */
export const DOMAIN_FLOW_AUTHORING_STANZA = `
## Domain Flow authoring

When shaping or triaging a task whose change introduces, alters, or removes
business behaviour, produce a Domain Flow by calling \`set_domain_flow\`.

Do not produce a flow for chores, build fixes, refactors, or changes with no
business-domain effect.

Naming: name each Domain Event in the operator's business language (e.g.
"Order Confirmed", "Payment Captured"), not code identifiers.

Structure: order nodes chronologically. Mark phase transitions as Pivotal
Events (\`pivotal: true\`). Record anything you are unsure about as a Hotspot
with a concrete question.

Display: after calling \`set_domain_flow\`, include the \`rendered\` text from
the tool response directly in your reply so the operator sees the flow inline.

Revisit: when entering a conversation about a task that already has a Domain
Flow, call \`get_domain_flow\` first and include the rendered output in your
reply before discussing changes.`

// ---------------------------------------------------------------------------
// Domain Flow → user story derivation stanza
// (consumed by: "Chat prompt — user story derivation from Domain Flow")
// ---------------------------------------------------------------------------

/**
 * Instruction stanza that teaches the chat agent how to derive user stories
 * from an existing Domain Flow.
 *
 * Append to the base system prompt so the agent knows the derivation protocol
 * when the operator asks to turn a Domain Flow into user stories.
 */
export const DOMAIN_FLOW_USER_STORY_STANZA = `
## User story derivation from Domain Flow

When the operator asks to derive user stories from a Domain Flow:

1. Call \`get_domain_flow\` to retrieve the agreed flow.
2. For each Domain Event node, derive a user story in the form "As a [relevant role], I want [what the event represents], so that [business outcome the event enables]".
3. For each Domain Policy node, derive a user story describing the rule the policy enforces.
4. Skip Hotspot nodes — unknowns are not ready for stories.
5. Write each story via \`mars proposal add-user-story <proposal_id> "<story>"\`.
6. Only derive stories when the operator explicitly asks — do not derive automatically after authoring a flow.`

// ---------------------------------------------------------------------------
// Resolved prompt contract
// ---------------------------------------------------------------------------

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
  if (!vision) {
    // No Vision stored yet — put the agent in onboarding mode.
    return CHAT_ONBOARDING_INTERVIEW_STANZA + CHAT_ONBOARDING_PROMPT + '\n\n---\n\n'
  }
  const parts: string[] = []
  if (name) parts.push(`Operator: ${name}.`)
  parts.push(`Project Vision (persisted; keep in mind every turn):\n${vision}`)
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
  return { prompt: stanza + base + DOMAIN_FLOW_AUTHORING_STANZA + DOMAIN_FLOW_USER_STORY_STANZA, source }
}
