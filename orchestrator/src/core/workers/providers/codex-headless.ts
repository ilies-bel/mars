// Codex headless adapter — normalises the `codex exec --json` JSONL stream
// into the orchestrator's legacy AgentEvent shape so downstream readers work
// unchanged. Authentication is deliberately delegated to Codex CLI: a local
// `codex login` ChatGPT OAuth session (or another CLI-supported auth method) is
// reused automatically and MARS never reads or copies credential material.
//
// Usage semantics are 'cumulative': the ONLY usage-bearing event is the
// terminal `turn.completed`, and its `usage` block is total spend for the
// whole turn — not context occupancy. Reading it as occupancy is what
// produced fabricated readouts like `289216/50000` and ctx% above 300%.

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import {
  runSubprocessStreaming,
  buildWorkerEnv,
  emptyPromptResult,
  isBlankPrompt,
} from '../../ports/executor/executor-helpers'
import type { RunAgentResult } from '../../ports/executor/types'
import type { AgentEvent } from '../../lib/claude-stream'
import type { HeadlessAdapter, HeadlessRunContext, HeadlessRunOpts } from '../provider-types'
import { providerBinPath } from '../provider-bin'

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isReadOnlyRun = (opts: HeadlessRunOpts): boolean => {
  // opts.forceSandbox is an explicit override and takes priority over the
  // disallowedTools-derived default — see the field's doc comment in
  // provider-types.ts for why a Worker (the rescue-operator) needs to deny
  // Edit/Write yet still run under workspace-write.
  if (opts.forceSandbox) return opts.forceSandbox === 'read-only'
  const denied = new Set(opts.disallowedTools ?? [])
  return denied.has('Edit') && denied.has('Write')
}

/**
 * Pull the human-readable message out of a codex `error` / `turn.failed`
 * envelope. `error` carries `message` at the top level; `turn.failed` nests it
 * under `error`.
 */
const codexErrorMessage = (parsed: Record<string, unknown>): string | null => {
  if (typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim()
  }
  const nested = parsed.error
  if (isObject(nested) && typeof nested.message === 'string' && nested.message.trim()) {
    return nested.message.trim()
  }
  return null
}

/**
 * Codex's wording for a rate/spend rejection. Verified against codex-cli
 * 0.145.0, which emits:
 *
 *   "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage
 *    to purchase more credits or try again at Aug 6th, 2026 11:58 PM."
 *
 * This is an ENVIRONMENTAL condition, not a code failure: the coder never ran
 * and the worktree is untouched. Recognising it routes the run into the
 * existing quota branch in the code step (re-queue + pause dispatch + one
 * action-queue row) instead of burning the task's single recovery slot on a
 * rejection that would reproduce instantly.
 */
// Deliberately NOT matching a bare "429": these strings are scanned against
// arbitrary provider error prose, and a three-digit number is far too easy to
// hit incidentally. Misreading an ordinary failure as a quota rejection would
// pause the whole queue, which is worse than missing one.
const CODEX_QUOTA_REJECTION_RE =
  /usage limit|rate limit|rate\/usage limit|quota exceeded|too many requests/i

/**
 * Codex reports the reset point as English prose inside the same sentence
 * ("… try again at Aug 6th, 2026 11:58 PM."), not as a machine field. Parse it
 * best-effort and fall back to 0, which the daemon already understands as
 * "unknown" and answers with a fixed 30-minute pause. An unparsed date must
 * never suppress the rejection itself.
 */
const parseCodexResetsAt = (message: string): number => {
  const match = /try again (?:at|after|on)\s+([^.]+)/i.exec(message)
  if (!match) return 0
  // Strip ordinal suffixes ("Aug 6th" → "Aug 6") so Date.parse can read it.
  const cleaned = match[1].trim().replace(/(\d+)(st|nd|rd|th)\b/gi, '$1')
  const parsed = Date.parse(cleaned)
  if (!Number.isFinite(parsed)) return 0
  const seconds = Math.floor(parsed / 1000)
  return seconds > 0 ? seconds : 0
}

/**
 * Scan a normalised codex conversation for a provider quota rejection.
 * Returns the daemon's `{ resetsAt }` sentinel, or null when the run failed
 * for any other reason.
 */
const extractCodexQuotaRejected = (
  conversation: readonly AgentEvent[],
): { resetsAt: number } | null => {
  for (let i = conversation.length - 1; i >= 0; i--) {
    const event = conversation[i]
    if (event.type !== 'result' || event.is_error !== true) continue
    const text = typeof event.result === 'string' ? event.result : ''
    if (text && CODEX_QUOTA_REJECTION_RE.test(text)) {
      return { resetsAt: parseCodexResetsAt(text) }
    }
  }
  return null
}

// `codex exec --help` exposes no system-instruction argument. Keep the
// unavoidable inlining explicit at this call site: Codex receives these as
// ordinary user text, so the user prompt must put non-negotiable exit
// conditions first rather than relying on system-role precedence.
export const composeCodexPrompt = (prompt: string, systemPrompt?: string): string =>
  systemPrompt?.trim()
    ? `<mars_system_instructions>\n${systemPrompt.trim()}\n</mars_system_instructions>\n\n${prompt}`
    : prompt

/**
 * Parse a single JSONL line from the `codex exec --json` stream into a
 * AgentEvent-shaped record, or `null` when the line should be discarded.
 *
 * Recognised mappings:
 *   item.completed(agent_message) → assistant event with text content block
 *   item.completed(reasoning)     → null (dropped; opaque to downstream readers)
 *   turn.completed                → result event; is_error reflects the codex error field
 *   error / turn.failed           → result event with is_error:true and the message
 *   everything else               → null
 *
 * `error` and `turn.failed` are NOT optional to handle. When codex refuses a
 * run outright (usage limit, auth failure, bad model) it writes those two
 * lines to STDOUT and nothing whatsoever to stderr except the benign
 * "Reading additional input from stdin..." notice it prints on every run
 * whose stdin is not a TTY. Dropping them left `conversation` empty, so the
 * code step's diagnostic fallback (extractLastStreamText) had nothing to
 * report and the task failed as `code/unclassified` with a stdin notice as
 * its only evidence — a real incident that churned two tasks in a 30-second
 * requeue loop with no way to see the cause.
 *
 * NOTHING usage-bearing is dropped here. Verified against codex-cli 0.145.0 by
 * capturing a full `codex exec --json` run (one prompt, one shell tool call):
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution",…}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution",…}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}
 *   {"type":"turn.completed","usage":{"input_tokens":31864,"cached_input_tokens":25088,
 *                                     "cache_write_input_tokens":0,"output_tokens":118,
 *                                     "reasoning_output_tokens":0}}
 *
 * No token/usage field appears on any item event, and `codex exec --help` on
 * this version exposes no incremental-usage or raw-protocol-event flag. The
 * terminal `turn.completed` really is the ONLY usage signal, which is why the
 * adapter declares 'cumulative' semantics and why no mid-run ceiling can exist
 * on this provider — see ContextGuardMode in ../../lib/claude-usage.
 */
export const parseCodexEventLine = (line: string): AgentEvent | null => {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null

  if (parsed.type === 'item.completed' && isObject(parsed.item)) {
    const item = parsed.item
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: item.text }],
        },
      }
    }
    // reasoning items and all other item subtypes are dropped.
    return null
  }

  // Terminal provider-side refusal. Two shapes, both observed on codex-cli
  // 0.145.0 within a single failed run:
  //   {"type":"error","message":"…"}
  //   {"type":"turn.failed","error":{"message":"…"}}
  if (parsed.type === 'error' || parsed.type === 'turn.failed') {
    const message = codexErrorMessage(parsed)
    if (!message) return null
    return { type: 'result', is_error: true, result: message }
  }

  if (parsed.type === 'turn.completed') {
    // Treat the presence of a non-null `error` field as an error condition.
    const hasError = parsed.error !== undefined && parsed.error !== null
    return {
      type: 'result',
      is_error: hasError,
      ...(isObject(parsed.usage) ? { usage: parsed.usage } : {}),
    }
  }

  return null
}

/**
 * Informational notices codex writes to stderr that are NOT errors.
 *
 * `codex exec` prints "Reading additional input from stdin..." on every run
 * whose stdin is not a TTY — which is every dispatched worker, since they are
 * spawned with `stdio: ['ignore', …]`. Left in place it is actively harmful:
 * the code step picks its failure diagnostic as "stderr tail if non-empty,
 * otherwise last stream text", so this one noise line outranks the real cause
 * sitting on stdout. That is precisely how a codex usage-limit rejection
 * reached an operator as `code/unclassified` with a stdin notice as its only
 * evidence. Strip the notice so an empty stderr genuinely means empty.
 */
const CODEX_BENIGN_STDERR_RE = /^\s*Reading additional input from stdin\.\.\.\s*$/

/** Drop codex's informational stderr notices, preserving everything else. */
export const stripBenignCodexStderr = (stderr: string): string => {
  const kept = stderr.split(/\r?\n/).filter((line) => !CODEX_BENIGN_STDERR_RE.test(line))
  // Collapse to '' when nothing but notices and blank lines remain, so the
  // caller's `stderr.trim().length > 0` test resolves the way it reads.
  return kept.join('\n').trim().length === 0 ? '' : kept.join('\n')
}

/** Read Codex's NDJSON stdout, ignoring blank and incomplete trailing lines. */
export const readCodexOutput = (stdout: string): AgentEvent[] =>
  stdout
    .split(/\r?\n/)
    .map((line) => parseCodexEventLine(line))
    .filter((event): event is AgentEvent => event !== null)

export const codexHeadless: HeadlessAdapter = {
  capabilities: {
    usageSemantics: 'cumulative',
    // Codex DOES surface rate/spend rejections — as an `error` / `turn.failed`
    // pair on stdout rather than a dedicated field. extractCodexQuotaRejected
    // recovers them, so this adapter populates RunAgentResult.quotaRejected.
    quotaRejected: true,
    sessionId: false,
  },
  readOutput: readCodexOutput,

  /**
   * The Codex CLI (`codex exec --json`) emits `turn.completed` at the end of
   * every run. The normalized form is a `result` AgentEvent with `is_error`
   * reflecting whether the run failed. There is no separate "stop_reason"
   * field in the JSONL protocol — a clean run is always `'complete'` and an
   * error (error/turn.failed events) is `'unknown'`.
   */
  extractStopReason: (events) => {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type !== 'result') continue
      // is_error:true on a result event means the run failed (quota, bad model,
      // etc.). There is no finer-grained signal from the CLI.
      return (event as { is_error?: unknown }).is_error === true ? 'unknown' : 'complete'
    }
    return 'unknown'
  },

  run: async (
    prompt: string,
    opts: HeadlessRunOpts,
    ctx?: HeadlessRunContext,
  ): Promise<RunAgentResult> => {
    // Refuse before spawning: `codex exec` with no prompt argument falls back
    // to reading stdin, which is /dev/null for dispatched workers, so it reads
    // EOF and exits 1 with no usable diagnostic. See EMPTY_PROMPT_REFUSAL.
    const composedPrompt = composeCodexPrompt(prompt, opts.systemPrompt)
    if (isBlankPrompt(composedPrompt)) return emptyPromptResult('codex')

    const conversation: AgentEvent[] = []
    const abort = new AbortController()
    let externalAborted = false

    if (ctx?.externalAbort) {
      if (ctx.externalAbort.aborted) {
        externalAborted = true
        abort.abort()
      } else {
        ctx.externalAbort.addEventListener('abort', () => {
          externalAborted = true
          abort.abort()
        }, { once: true })
      }
    }

    // Build the list of extra writable directories to pass to codex via --add-dir.
    //
    // FIX 1 — git common dir (objects + refs):
    //   codex exec --sandbox workspace-write allows writes to workdir, /tmp, and
    //   $TMPDIR, but NOT to the repo's common .git directory. When the coder runs
    //   `git commit` inside a linked worktree, git must write to three locations
    //   inside that common dir:
    //
    //     • objects/            — blob and tree storage for `git add`
    //     • refs/heads/<branch> — branch pointer updated by `git commit`
    //     • worktrees/<id>/     — per-worktree index.lock, ORIG_HEAD, MERGE_MSG, etc.
    //
    //   All three live under the COMMON git dir (`git rev-parse --git-common-dir`),
    //   which for a linked worktree is the repository root .git/, e.g. /repo/.git.
    //   Granting only the per-worktree metadata dir (`--git-dir`, e.g.
    //   /repo/.git/worktrees/<task-id>) covers index.lock and friends but MISSES
    //   objects/ and refs/heads/, so `git add` fails with "Operation not permitted"
    //   and commits are never written — the mars-486c9b94 incident.
    //
    //   Sibling worktrees live under <repoRoot>/.mars/worktrees/, which is NOT under
    //   <repoRoot>/.git/, so granting the common git dir does NOT reopen the
    //   sibling-contamination hole closed by mars-651807ec.
    //
    // FIX 2 (partial) — npm/pnpm install stall:
    //   npm install of new dependencies stalls ~150s because the workspace-write
    //   sandbox blocks outbound network (macOS sandbox-exec). The pnpm content-
    //   addressable store (~/.pnpm-store) is also outside the sandbox boundary, so
    //   pnpm cannot read its cache even for packages already downloaded. Adding the
    //   pnpm store as a writable dir allows pnpm to serve already-cached packages
    //   without network. For packages NOT yet in the store, network access remains
    //   blocked; see CLAUDE.md for the full npm-install-in-sandbox limitation.
    const addDirArgs: string[] = []
    if (!isReadOnlyRun(opts)) {
      // --- git common dir (objects/, refs/heads/, worktrees/<id>/) ---
      try {
        const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: opts.cwd,
          encoding: 'utf8',
        }).trim()
        if (gitCommonDir) {
          // For a linked worktree, --git-common-dir returns an absolute path like
          // /repo/.git. resolve() handles the rare relative `.git` case (plain
          // checkout) by prefixing cwd. This single grant covers objects/, refs/,
          // and worktrees/<id>/ — everything git needs to commit from a linked worktree.
          addDirArgs.push('--add-dir', resolve(opts.cwd, gitCommonDir))
        }
      } catch {
        // Best-effort: if git is unavailable or cwd is not inside a git repo,
        // skip --add-dir for the git dir. Sandbox restrictions will prevent
        // commits, but the session itself will still start.
      }

      // --- pnpm content-addressable store ---
      // Allows pnpm to serve already-cached packages without network access.
      try {
        const pnpmStore = execFileSync('pnpm', ['store', 'path'], {
          cwd: opts.cwd,
          encoding: 'utf8',
        }).trim()
        if (pnpmStore) {
          addDirArgs.push('--add-dir', pnpmStore)
        }
      } catch {
        // pnpm not available or store path query failed — skip.
      }
    }

    // Resolved once per process (see provider-bin.ts) and reused, so a
    // mid-session PATH change cannot silently break every subsequent run.
    const result = await runSubprocessStreaming(
      providerBinPath('codex'),
      [
        'exec',
        '--ephemeral',
        '--json',
        '--model',
        opts.model ?? 'gpt-5.6-sol',
        '-c',
        `model_reasoning_effort="${opts.effort ?? 'high'}"`,
        '--sandbox',
        isReadOnlyRun(opts) ? 'read-only' : 'workspace-write',
        ...addDirArgs,
        composedPrompt,
      ],
      opts.cwd,
      async ({ stream, line }) => {
        if (stream !== 'stdout') return
        const ev = parseCodexEventLine(line)
        if (!ev) return
        conversation.push(ev)
        if (ctx?.onEvent) await ctx.onEvent(ev)
      },
      abort.signal,
      buildWorkerEnv(),
      ctx?.onPid,
    )

    if (externalAborted) {
      return {
        exitCode: 138,
        stdout: result.stdout,
        stderr: 'codex exec aborted by caller (read/grep span watcher)',
        sessionId: null,
        conversation,
        quotaRejected: null,
      }
    }

    return {
      ...result,
      // See CODEX_BENIGN_STDERR_RE: an unstripped notice line masquerades as a
      // failure diagnostic and hides the real cause on stdout.
      stderr: stripBenignCodexStderr(result.stderr),
      sessionId: null,
      conversation,
      quotaRejected: extractCodexQuotaRejected(conversation),
    }
  },
}
