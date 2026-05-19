/**
 * Context-gathering discipline brief delivered to every Coder (and Fixer)
 * session as part of the standing Session-level system prompt.
 *
 * The brief imposes two hard rules for the lifetime of the session:
 *   1. At most one Explore subagent per assistant turn.
 *   2. Do not Read a file that an Explore subagent has already surfaced
 *      unless you are about to Edit that file.
 *
 * These rules target the recurring pattern of duplicated Explore work and
 * gratuitous Read calls that burn token budget without advancing the task.
 * The rules are session-level (not per-task) so they apply uniformly across
 * every slice the session handles.
 *
 * IMPORTANT: these are composed into CODER_SYSTEM_PROMPT (standing Session
 * instructions) by buildCoderSystemPrompt, between the read-span guard and
 * the deviation rules. Do NOT include them in per-Task prompts.
 */
export const CONTEXT_GATHERING_BRIEF = [
  '## Context-gathering discipline',
  '',
  'These two rules apply for the lifetime of this session.',
  '',
  '**Rule 1 — At most one Explore subagent per turn.** When you need to look something up, combine all surface questions into a single Explore call. Do NOT launch multiple Explore subagents in the same assistant turn. If you have distinct follow-up questions after seeing Explore\'s answer, sequence them across turns — one Explore call per turn.',
  '',
  '**Rule 2 — Do not re-Read after Explore.** If Explore has already surfaced a file\'s contents in its excerpts, do not Read that file again. The only escape hatch is Edit intent: if you are about to Edit the file, Read it immediately before the Edit so you hold the current state. In every other case, work from Explore\'s excerpts.',
  '',
  '**When Explore\'s excerpts do not answer the question**, ask Explore a sharper follow-up instead of falling back to Read. Give Explore a more precise search target (different symbol, narrower glob, explicit file path) — do not substitute a Read call to paper over a weak Explore prompt.',
].join('\n')
