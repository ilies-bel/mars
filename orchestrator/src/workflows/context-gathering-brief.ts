/**
 * Context-gathering discipline brief delivered to every Coder (and Fixer)
 * session as part of the standing Session-level system prompt.
 *
 * The brief imposes two hard rules for the lifetime of the session:
 *   1. At most one Explore subagent per turn.
 *   2. Choose the tool by intent: use Explore for broad discovery; Read
 *      a known target file directly when you need its full contents to
 *      implement a change. Do not re-Read a file Explore already surfaced
 *      unless you are about to Edit it.
 *
 * It also includes a codegraph-first exploration directive (Rule 3) that
 * degrades gracefully: it is conditioned on codegraph being available, so it
 * applies only in environments where the tool is registered. This brief ships
 * to every Mars-managed project, so it must not assume codegraph is present.
 *
 * These rules target the recurring pattern of duplicated Explore work and
 * gratuitous Read calls that burn token budget without advancing the task.
 * The rules are session-level (not per-task) so they apply uniformly across
 * every slice the session handles.
 *
 * IMPORTANT: these are composed into CODER_SYSTEM_PROMPT (standing Session
 * instructions) by buildCoderSystemPrompt, between the TDD brief and the
 * deviation rules. Do NOT include them in per-Task prompts.
 */
export const CONTEXT_GATHERING_BRIEF = [
  '## Context-gathering discipline',
  '',
  'These two rules apply for the lifetime of this session.',
  '',
  "**Rule 1 — At most one Explore subagent per turn.** When you need to look something up, combine all surface questions into a single Explore call. Do NOT launch multiple Explore subagents in the same assistant turn. If you have distinct follow-up questions after seeing Explore's answer, sequence them across turns — one Explore call per turn.",
  '',
  '**Rule 2 — Choose the tool by intent.** For broad discovery ("where is X defined?", "which files reference Y?") use Explore (or codegraph when available). For a known target file whose full contents you need to write an edit, Read it directly — routing through Explore costs an extra round-trip and returns only excerpts. If Explore has already surfaced a file\'s contents, do not Read it again unless you are about to Edit it.',
  '',
  '**Rule 3 — codegraph-first exploration (when available).** If `codegraph` is on PATH, prefer it over `rg`/grep+Read sweeps when answering "where is X defined?", "what calls Y?", or "how does Z work?" questions. Three invocations cover most needs:',
  '',
  '  codegraph query <SymbolName>          # locate a symbol definition',
  '  codegraph callees <functionName>      # trace how a function works (what it calls)',
  '  codegraph callers <symbolName>        # who calls this; also: codegraph impact <symbolName> for change-impact analysis',
  '',
  'Fall back to `rg`/grep or `Read` only to confirm a specific detail codegraph did not surface. If `codegraph` is not on PATH, skip this rule entirely and rely on the Explore + rg/Read discipline above.',
].join('\n')
