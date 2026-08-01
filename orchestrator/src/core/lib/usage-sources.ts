// Provider-agnostic usage source seam.
//
// Each agent provider surfaces token usage through a different mechanism:
//   claude (headless)  — in-memory conversation events (--stream-json)
//   claude (pty/empty) — ~/.claude/projects/.../<session_id>.jsonl
//   codex              — <cwd>/.mars/pty/<session_id>.log (raw terminal output)
//   gemini             — <cwd>/.mars/pty/<session_id>.log (raw terminal output)
//
// resolveUsage dispatches to the right adapter so every provider yields
// UsageTotals in one shape. Two real log-based adapters make this a genuine
// seam, not a hypothetical abstraction.

import { existsSync, readdirSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeEvent } from './claude-stream'
import { emptyUsageTotals, summarizeUsage, summarizeUsageForSemantics } from './claude-usage'
import type { UsageTotals, ProviderUsageSemantics } from './claude-usage'
import type { ProviderName } from '../workers/provider-types'

export interface UsageSourceContext {
  /** In-memory conversation events. Non-empty for any headless run. */
  readonly conversation: readonly ClaudeEvent[]
  /** Session ID for this run, used to locate persisted logs. */
  readonly sessionId: string | null
  /** Working directory where .mars/pty/ traces are persisted. */
  readonly cwd: string
  /** Agent CLI provider that produced this run. */
  readonly provider: ProviderName
  /**
   * How this provider reports usage on its event stream. Decides WHERE in the
   * conversation the token numbers live; without it the resolver read the
   * per-request (assistant) shape for every provider and returned zeros for
   * codex, whose only usage block rides the terminal `turn.completed` event.
   */
  readonly semantics: ProviderUsageSemantics
}

/** True when a totals record carries at least one non-zero token bucket. */
const hasTokens = (totals: UsageTotals): boolean =>
  totals.inputTokens + totals.outputTokens + totals.cacheCreateTokens + totals.cacheReadTokens > 0

/**
 * Provider-agnostic usage resolver. Reads the in-memory event stream FIRST,
 * using the provider's own usage semantics, and only falls back to a persisted
 * log when the stream carried no usage at all (the pty runtime emits no
 * events, and a run killed before its first usage block has none either):
 *   - claude → session JSONL under ~/.claude/projects/
 *   - codex / gemini → the PTY raw log under <cwd>/.mars/pty/
 */
export const resolveUsage = async (ctx: UsageSourceContext): Promise<UsageTotals> => {
  const fromStream = summarizeUsageForSemantics(ctx.semantics, ctx.conversation)
  if (hasTokens(fromStream)) return fromStream

  if (ctx.provider === 'claude' && ctx.sessionId !== null) {
    const fromFile = await claudeSessionJsonlAdapter(ctx.sessionId)
    if (fromFile !== null) return fromFile
  }
  if (ctx.provider === 'codex' && ctx.sessionId !== null) {
    return codexPtyLogAdapter(join(ctx.cwd, '.mars', 'pty', `${ctx.sessionId}.log`))
  }
  if (ctx.provider === 'gemini' && ctx.sessionId !== null) {
    return geminiPtyLogAdapter(join(ctx.cwd, '.mars', 'pty', `${ctx.sessionId}.log`))
  }
  return emptyUsageTotals()
}

/**
 * Searches `claudeProjectsDir/<any>/<sessionId>.jsonl`, parses per-turn
 * usage events, and returns aggregated UsageTotals. Returns null when the
 * file cannot be located.
 *
 * The second parameter defaults to `~/.claude/projects/` and is overridable
 * in tests without touching the real home directory.
 */
export const claudeSessionJsonlAdapter = async (
  sessionId: string,
  claudeProjectsDir: string = join(homedir(), '.claude', 'projects'),
): Promise<UsageTotals | null> => {
  if (!existsSync(claudeProjectsDir)) return null
  let filePath: string | null = null
  for (const entry of readdirSync(claudeProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(claudeProjectsDir, entry.name, `${sessionId}.jsonl`)
    if (existsSync(candidate)) {
      filePath = candidate
      break
    }
  }
  if (filePath === null) return null
  const events: ClaudeEvent[] = []
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line) as ClaudeEvent)
    } catch {
      // skip malformed lines — the JSONL may be partially written
    }
  }
  return summarizeUsage(events)
}

/**
 * Parses a codex PTY raw log for token-usage lines.
 *
 * Codex CLI emits a usage summary after completing each task:
 *   Usage: X tokens (input: A, output: B, cached: C, reasoning: D)
 *
 * Accumulates across all matching lines (multi-turn sessions may emit
 * multiple usage summaries). Returns emptyUsageTotals() when the file is
 * absent or contains no matching lines.
 */
export const codexPtyLogAdapter = async (logPath: string): Promise<UsageTotals> => {
  if (!existsSync(logPath)) return emptyUsageTotals()
  const totals = emptyUsageTotals()
  const rl = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity })
  for await (const rawLine of rl) {
    const line = stripAnsi(rawLine)
    // Codex usage format: "Usage: ... (input: X, output: Y, cached: Z, ...)"
    const m = line.match(/\bUsage:.*?\(([^)]+)\)/i)
    if (m) {
      const fields = m[1]!
      totals.inputTokens += parseCommaNumber(fields, /\binput:\s*([\d,]+)/i)
      totals.outputTokens += parseCommaNumber(fields, /\boutput:\s*([\d,]+)/i)
      totals.cacheReadTokens += parseCommaNumber(fields, /\bcached:\s*([\d,]+)/i)
    }
  }
  return totals
}

/**
 * Parses a gemini PTY raw log for token-usage lines.
 *
 * Gemini CLI emits token counts after each task cycle in one of:
 *   Token usage: input=X output=Y
 *   tokens: X (input: A, cached: B, output: C)
 *
 * Accumulates across all matching lines. Returns emptyUsageTotals() when
 * the file is absent or contains no matching lines.
 */
export const geminiPtyLogAdapter = async (logPath: string): Promise<UsageTotals> => {
  if (!existsSync(logPath)) return emptyUsageTotals()
  const totals = emptyUsageTotals()
  const rl = createInterface({ input: createReadStream(logPath), crlfDelay: Infinity })
  for await (const rawLine of rl) {
    const line = stripAnsi(rawLine)
    if (/token\s+usage:/i.test(line) || /\btokens?:/i.test(line)) {
      totals.inputTokens += parseCommaNumber(line, /\binput[=:]\s*([\d,]+)/i)
      totals.outputTokens += parseCommaNumber(line, /\boutput[=:]\s*([\d,]+)/i)
      totals.cacheReadTokens += parseCommaNumber(line, /\bcached[=:]\s*([\d,]+)/i)
    }
  }
  return totals
}

// Strip ANSI escape sequences from a terminal output string.
// Used by codexPtyLogAdapter and geminiPtyLogAdapter before regex matching.
const stripAnsi = (str: string): string =>
  // CSI sequences: ESC [ ... final-byte
  // OSC sequences: ESC ] ... (BEL or ESC \)
  str
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')

// Extract a number from text using a regex, treating commas as thousands separators.
// Used by codexPtyLogAdapter and geminiPtyLogAdapter to parse field values.
const parseCommaNumber = (text: string, pattern: RegExp): number => {
  const m = text.match(pattern)
  if (!m?.[1]) return 0
  const n = parseInt(m[1].replace(/,/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}
