import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { parseClaudeStreamLine, extractQuotaRejected, type ClaudeEvent } from '../claude-stream'
import { getLatestContextSize } from '../claude-usage'
import { FALLBACK_CLAUDE_PATH_DIRS, isExecutableFile } from './internal'
import { apiCircuitBreaker } from '../api-circuit-breaker'

export interface RunSubprocessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SubprocessLine {
  stream: 'stdout' | 'stderr'
  line: string
}

// Live PIDs for every subprocess spawned through this module. Used by
// `mars daemon kill` to terminate every child claude -p (and any git/verify
// subprocess) when foreground-mode pgid signalling isn't safe. Entries are
// added at spawn time and removed on 'close'/'error'.
const liveChildPids = new Set<number>()

export const getLiveChildPids = (): readonly number[] => Array.from(liveChildPids)

// SIGKILL every tracked child's process group. Each child is spawned with
// `detached: true` so it leads its own process group; signalling -pid kills
// the leader AND every descendant (npm → vitest → forks) atomically.
// Best-effort: a group that has already exited or that the process lacks
// permission to signal is silently skipped. Returns the list of PIDs we
// attempted to kill.
export const killAllChildren = (): readonly number[] => {
  const killed: number[] = []
  for (const pid of liveChildPids) {
    try {
      process.kill(-pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // child already gone or unsignalable
    }
  }
  return killed
}

export const runSubprocessStreaming = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  onLine?: (event: SubprocessLine) => void | Promise<void>,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
  onSpawn?: (pid: number) => void,
): Promise<RunSubprocessResult> =>
  new Promise((resolveFn) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Make the child the leader of a new process group so that
      // `process.kill(-pid, 'SIGKILL')` reaps the entire subtree
      // (npm → vitest → forks) on abort/kill, not just the direct child.
      // We do NOT call child.unref() — the daemon must still stream output
      // and await the 'close' event.
      detached: true,
    })
    if (typeof child.pid === 'number') {
      liveChildPids.add(child.pid)
      // Notify the caller immediately so the dispatch path can record the PID
      // on the in-flight tracker entry before the first watchdog sweep fires.
      onSpawn?.(child.pid)
    }
    let stdout = ''
    let stderr = ''
    const buffers: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }

    const handleChunk = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString()
      if (stream === 'stdout') stdout += text
      else stderr += text
      if (!onLine) return
      buffers[stream] += text
      let newlineIndex = buffers[stream].indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffers[stream].slice(0, newlineIndex).replace(/\r$/, '')
        buffers[stream] = buffers[stream].slice(newlineIndex + 1)
        try {
          void onLine({ stream, line })
        } catch {
          // Swallow handler errors — they must not abort the subprocess capture.
        }
        newlineIndex = buffers[stream].indexOf('\n')
      }
    }

    const onAbort = () => {
      // Signal the entire process group so descendants (npm → vitest → forks)
      // die with the direct child. Falls back to child.kill() when pid is
      // unavailable (spawn failure before a pid was assigned).
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // process group already gone
        }
      } else if (!child.killed) {
        child.kill('SIGKILL')
      }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk) => handleChunk('stdout', chunk))
    child.stderr?.on('data', (chunk) => handleChunk('stderr', chunk))
    let settled = false
    const settle = (result: RunSubprocessResult): void => {
      if (settled) return
      settled = true
      if (signal) signal.removeEventListener('abort', onAbort)
      resolveFn(result)
    }
    // A spawn failure (e.g. ENOENT for a missing binary, EACCES) emits
    // 'error' on the ChildProcess. Without this listener Node treats it as an
    // unhandled 'error' event and crashes the entire daemon process.
    //
    // ENOENT IS AMBIGUOUS. Node raises the SAME `spawn <cmd> ENOENT` error for
    // two completely different causes:
    //   (a) the executable is not on PATH  → genuinely "command not found";
    //   (b) `options.cwd` does not exist   → the binary is fine; the working
    //       directory was deleted out from under the dispatch.
    // Case (b) is what a resumed run hits when its worktree was removed while
    // the task was parked, and the raw message sends every reader hunting a
    // PATH problem that does not exist. Probe the cwd and name the real cause
    // so the failure is diagnosable instead of contentless.
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (typeof child.pid === 'number') liveChildPids.delete(child.pid)
      const detail = err.code ? `${err.code}: ${err.message}` : err.message
      let diagnosis = `spawn ${cmd} ${detail}`
      if (err.code === 'ENOENT' && !existsSync(cwd)) {
        diagnosis =
          `spawn failed: working directory does not exist: ${cwd} ` +
          `(command '${cmd}' was never executed; this is NOT a PATH or missing-binary problem) — ${detail}`
      } else if (err.code === 'ENOENT') {
        diagnosis = `spawn failed: command not found: '${cmd}' (cwd ${cwd} exists) — ${detail}`
      }
      settle({
        exitCode: err.code === 'ENOENT' ? 127 : 1,
        stdout,
        stderr:
          stderr + (stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n') + diagnosis,
      })
    })
    child.on('close', (code) => {
      if (typeof child.pid === 'number') liveChildPids.delete(child.pid)
      if (onLine) {
        for (const stream of ['stdout', 'stderr'] as const) {
          if (buffers[stream].length > 0) {
            const line = buffers[stream].replace(/\r$/, '')
            buffers[stream] = ''
            try {
              void onLine({ stream, line })
            } catch {
              // Swallow handler errors — final flush must not throw.
            }
          }
        }
      }
      settle({ exitCode: code ?? 1, stdout, stderr })
    })
  })

export const runSubprocess = (
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<RunSubprocessResult> => runSubprocessStreaming(cmd, args, cwd)

export interface RunClaudeArgs {
  cwd: string
  prompt: string
  /**
   * Wall-clock timeout in milliseconds. If omitted or ≤ 0, no timeout is
   * armed and the subprocess runs to completion (or until Ctrl-C).
   */
  timeoutMs?: number
  model?: string
  systemPrompt?: string
  sessionId?: string
  onEvent?: (event: ClaudeEvent) => void | Promise<void>
  // Per-Worker pinned config (claude -p flags). All optional; the wrapper
  // applies them on top of the existing argv. Agent-to-user denials always
  // remain in --disallowedTools regardless of caller-supplied disallowedTools.
  effort?: ClaudeEffort
  permissionMode?: ClaudePermissionMode
  bare?: boolean
  agent?: string
  disallowedTools?: ReadonlyArray<string>
  // Per-invocation context token budget. When the LATEST assistant event's
  // input-side token count (input + cache_read + cache_creation) crosses this
  // value, runClaudeCode warns once at 80% and aborts (exit 138, distinct
  // stderr) at 100%. 0 = disabled.
  maxContextTokens?: number
  /**
   * Extra MCP server entries merged into the inline `--mcp-config` JSON on
   * top of the always-injected codegraph server. Because every dispatched
   * worker runs under `--strict-mcp-config`, this is the ONLY way an extra
   * server loads for a dispatched run. A worker MAY pin extra MCP servers
   * the operator has already provisioned in their environment. Keyed by
   * server name; values follow the `mcpServers` entry shape
   * (`{ type: 'stdio', command, args }`).
   */
  mcpServers?: Readonly<Record<string, unknown>>
  /**
   * Optional caller-supplied abort signal. When fired, runClaudeCode
   * SIGKILLs the child and returns a `exitCode: 137` result. Used by the
   * read/grep span watcher to terminate sessions that have stalled on
   * reads. The signal is ORed with the internal timeout abort, so either
   * side can trigger termination.
   */
  externalAbort?: AbortSignal
  /**
   * Optional callback invoked immediately after the child subprocess is
   * spawned, with the child's OS PID. The dispatch path uses this to call
   * `tracker.recordPid(taskId, pid)` so the phantom-task watchdog can use
   * PID liveness to protect legitimately long runs instead of falling back
   * to the bare wall-clock ceiling on `task.updatedAt`.
   *
   * Called at most once per `runClaudeCode` invocation (the subprocess is
   * spawned exactly once). Not called when the spawn fails (ENOENT / EACCES)
   * because no PID is assigned before the 'error' event fires.
   */
  onPid?: (pid: number) => void
  /**
   * The task id this invocation is dispatched for. When set:
   *   1. `buildWorkerEnv` stamps `MARS_MCP_TASK_ID=<taskId>` in the worker env
   *      so the injected mars-worker MCP server can route `mars_task_note` calls
   *      back to the correct task without accepting an id from the model.
   *   2. The mars-worker stdio MCP server is merged into the inline `--mcp-config`
   *      JSON (alongside any operator-provisioned `mcpServers`) so every
   *      dispatched Coder/Fixer run inherits the tool.
   */
  taskId?: string
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ClaudePermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan'

export interface RunClaudeResult extends RunSubprocessResult {
  sessionId: string | null
  conversation: ClaudeEvent[]
  /**
   * Non-null when the provider rejected this run due to rate/spend limits.
   * `resetsAt` is the Unix-second timestamp when limits are expected to lift
   * (0 when unknown). Callers must NOT treat a quota-rejected run as a code
   * failure — it consumes no recovery slot and the task re-queues for later.
   */
  quotaRejected: { resetsAt: number } | null
}

/**
 * First line of the synthetic stderr every headless adapter emits when it is
 * asked to spawn its provider CLI with a blank prompt. Load-bearing text:
 * `errorClassRules` in ../failure-signature.ts matches this phrase to mint the
 * `empty-prompt` error class, so the failure arrives named instead of as
 * `.../unclassified`.
 *
 * Why a guard exists at all: EVERY provider CLI here takes the prompt as an
 * argv value (`claude -p <prompt>`, `gemini -p <prompt>`, `codex exec
 * <prompt>`), and all three fall back to reading the prompt from stdin when
 * that value is absent or empty. Dispatched workers are spawned with
 * `stdio: ['ignore', …]`, so stdin is /dev/null: the CLI reads EOF, gets
 * nothing, and dies with a contentless non-zero exit. That symptom is
 * indistinguishable from a real coder failure, which is exactly the kind of
 * baffling exit this guard converts into a diagnosis.
 */
export const EMPTY_PROMPT_REFUSAL = (provider: string): string =>
  `refusing to spawn ${provider} with an empty prompt (the composed prompt was blank; ` +
  `the CLI would have fallen back to reading stdin, which is /dev/null for dispatched workers, ` +
  `and exited non-zero with no diagnostic)`

/**
 * Synthetic "we never spawned anything" result.
 *
 * Deliberately a returned non-zero {@link RunClaudeResult} rather than a
 * thrown error: the code step already owns a tested non-zero-exit path that
 * stamps the row, computes a failure signature from the stderr text, and
 * spawns exactly one recovery task. Throwing would bypass all of it and land
 * as an unclassified step crash. exitCode 1 keeps the failure inside the
 * machinery that names it.
 */
export const emptyPromptResult = (provider: string): RunClaudeResult => ({
  exitCode: 1,
  stdout: '',
  stderr: EMPTY_PROMPT_REFUSAL(provider),
  sessionId: null,
  conversation: [],
  quotaRejected: null,
})

/** True when a prompt carries no content the provider CLI could act on. */
export const isBlankPrompt = (prompt: string | undefined): boolean =>
  prompt === undefined || prompt.trim().length === 0

export const extractSessionIdFromConversation = (
  conversation: ClaudeEvent[],
): string | null => {
  for (const event of conversation) {
    const sid = (event as { session_id?: unknown }).session_id
    if (typeof sid === 'string' && sid.length > 0) return sid
  }
  return null
}

const extractSessionId = (stdout: string): string | null => {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const match = trimmed.match(/"session_id"\s*:\s*"([^"]+)"/)
  return match?.[1] ?? null
}

interface ClaudeStreamArgsOptions {
  model?: string
  systemPrompt?: string
  sessionId?: string
  effort?: ClaudeEffort
  permissionMode?: ClaudePermissionMode
  bare?: boolean
  agent?: string
  // Caller-supplied disallowed tools. Unioned with AGENT_TO_USER_DENIED_TOOLS;
  // duplicates collapse. The agent-to-user denial cannot be removed by a caller.
  disallowedTools?: ReadonlyArray<string>
  // Inline MCP config JSON string passed to `claude --mcp-config`. Because
  // every dispatched worker runs under `--strict-mcp-config`, the consumer
  // repo's `.mcp.json` is NOT auto-discovered — only servers handed in via
  // `--mcp-config` load. We inject the codegraph server here so workers get
  // `codegraph_*` tools (see codegraphMcpConfigJson / runClaudeCode). Omitted
  // when empty so unit tests that build args without a cwd stay flag-free.
  mcpConfig?: string
}

// Resolve the main checkout root for a worker `cwd`. A dispatched worker runs
// inside a worktree (`.mars/worktrees/<id>/`), but codegraph's index lives in
// the MAIN checkout's `.codegraph/` (built once over the integration branch).
// `git rev-parse --git-common-dir` from a worktree points at the main repo's
// `.git`; its parent is the main checkout root that holds `.codegraph/`.
// Falls back to `cwd` when git resolution fails (non-git dir, missing git) so
// the caller still gets a usable path rather than throwing.
export const resolveCodegraphRoot = (cwd: string): string => {
  try {
    const res = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' },
    )
    if (res.status === 0) {
      const commonDir = res.stdout.trim()
      // .../<repo>/.git -> .../<repo>; a bare or detached layout that does not
      // end in `.git` is left to its own parent, which is still the repo root.
      if (commonDir.length > 0) return dirname(commonDir)
    }
  } catch {
    // git absent or spawn failed — fall through to cwd.
  }
  return cwd
}

// Build the inline `--mcp-config` JSON for the codegraph stdio server.
//
// NOTE: as of ADR-0062, dispatched Mars WORKERS no longer receive the codegraph
// MCP server at all — they use the codegraph CLI directly (see
// CODEGRAPH_CLI_SYSTEM_PROMPT below). This function is preserved as a utility
// for callers that opt in explicitly (e.g. interactive tooling), but
// runClaudeCode no longer passes it via mcpConfig.
//
// Interactive-session template context (src/init/templates/mcp.json):
//   serve --mcp            — bare, cwd-resolved index, file watcher ON
// Worker config (this function, no longer called by default):
//   serve --mcp --no-watch --path <root>  — pinned, no per-worker watcher
//
// DO NOT restore the mcpConfig injection in runClaudeCode without updating
// CODEGRAPH_CLI_SYSTEM_PROMPT and the divergence note in templates/mcp.json.
//
// See also: templates/mcp.json `_comment` field for the interactive-session side.
export const codegraphMcpConfigJson = (
  repoRoot: string,
  extraServers?: Readonly<Record<string, unknown>>,
): string =>
  JSON.stringify({
    mcpServers: {
      codegraph: {
        type: 'stdio',
        command: 'codegraph',
        args: ['serve', '--mcp', '--no-watch', '--path', repoRoot],
      },
      // Worker-pinned extra servers (WorkerConfig.mcpConfig) — operator-
      // provisioned MCP servers a Worker MAY declare. Merged AFTER codegraph
      // so a Worker could in principle override it, though none do by default.
      ...(extraServers ?? {}),
    },
  })

// Agent-to-user tools denied for every dispatched Session. No human is
// listening on a dispatched run, so a call to either tool errors at the
// claude runtime and tempts the agent to silently drift from the task.
// Denying them at the single shared wrapper means every workflow — including
// any path that bypasses the Worker primitive and calls the wrapper directly
// — inherits the ban. See idea 948691d0.
export const AGENT_TO_USER_DENIED_TOOLS = ['AskUserQuestion', 'SendUserMessage'] as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Normalize an orchestrator session id into a value `claude --session-id`
 * accepts. Modern Claude Code requires a valid RFC 4122 UUID; task ids (e.g.
 * "mars-9afa7df6") are not UUIDs, so we derive a deterministic UUID v5
 * (SHA-1 over the DNS namespace + task-id bytes) rather than storing a
 * separate mapping. An id that already looks like a UUID is returned
 * unchanged, so a given task id maps to the same session UUID on every path.
 *
 * Both spawn paths MUST funnel through this: the PTY provider (providers.ts)
 * and the headless/stream path (claudeStreamArgs below). Passing a raw
 * non-UUID id makes claude reject the run with "Invalid session ID. Must be a
 * valid UUID.", exiting non-zero before doing any work — which previously
 * merged as a false empty-diff success.
 */
export const toClaudeSessionId = (sessionId: string): string => {
  if (UUID_RE.test(sessionId)) return sessionId
  const h = createHash('sha1')
    .update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex')) // DNS namespace
    .update(sessionId)
    .digest()
  h[6] = (h[6] & 0x0f) | 0x50 // version 5
  h[8] = (h[8] & 0x3f) | 0x80 // variant RFC 4122
  return [h.slice(0, 4), h.slice(4, 6), h.slice(6, 8), h.slice(8, 10), h.slice(10, 16)]
    .map((b) => b.toString('hex'))
    .join('-')
}

// Default search-tool guidance injected into every dispatched worker's system
// prompt. The host previously enforced this via PreToolUse rewriter hooks on
// the user's Claude settings; centralising it here keeps the constraint with
// the orchestrator and propagates to every workflow path.
export const SEARCH_TOOL_SYSTEM_PROMPT =
  'Use `rg` (ripgrep) instead of `grep`/`egrep`/`fgrep`, and `fd` instead of `find`. Both are installed; they are faster, respect .gitignore by default, and have saner defaults.'

// Worktree-confinement directive prepended to EVERY dispatched worker's system
// prompt. A dispatched worker is spawned with cwd = its own git worktree and
// runs under --dangerously-skip-permissions (no per-write approval) with no
// --add-dir sandbox, so nothing but instruction stops it writing elsewhere on
// disk. Critically, --setting-sources project,local loads the consumer repo's
// CLAUDE.md, which is written for INTERACTIVE humans and says things like
// "cd back to the repo root" / "always operate from the repo root". A worker
// that obeys that literally cd's out of its worktree into the PRIMARY checkout
// (which sits on the integration branch) and edits there — silently dirtying
// `main` and losing the work off its own task branch. This directive
// countermands that for the dispatch path: stay in the worktree, always.
export const WORKTREE_CONFINEMENT_SYSTEM_PROMPT =
  'You are running inside a dedicated git worktree that is your current working directory. ALL of your work — reads, edits, commits, and shell commands — must happen here, against this worktree and its branch. Do NOT `cd` to the repository root or any parent directory, and do NOT read or write absolute paths outside this worktree, even if project instructions (e.g. a CLAUDE.md) tell you to "operate from the repo root" or "cd back to the repo root" — that guidance targets interactive human sessions, not you. Editing outside this worktree corrupts the shared integration branch and loses your work. If a path looks like it points at the repository root instead of this worktree, treat it as a mistake and resolve it relative to your worktree instead.'

// Codegraph CLI guidance injected into every dispatched worker's system prompt.
// Workers no longer receive the codegraph MCP server (removed to cut the fixed
// token tax from schema + instruction injection on every task). Instead, they
// invoke the codegraph CLI directly — cheaper per-query and more legible than
// grep+Read sweeps. Three concrete invocations covering the most common needs:
//
//   codegraph query <SymbolName>          # locate a symbol definition
//   codegraph callees <functionName>      # trace how a function works (what it calls)
//   codegraph callers <symbolName>        # who calls this; also: codegraph impact <symbolName>
//
// If codegraph is not on PATH, fall back to rg/fd+Read silently — do not error
// or loop on the missing binary. (codegraph is a soft dependency per ADR-0062.)
export const CODEGRAPH_CLI_SYSTEM_PROMPT =
  'The `codegraph` CLI provides fast code intelligence — prefer it over `rg`/grep+Read sweeps when it is on PATH. Three invocations that cover most needs:\n\n  codegraph query <SymbolName>          # locate a symbol definition\n  codegraph callees <functionName>      # trace how a function works (what it calls)\n  codegraph callers <symbolName>        # who calls this; also: codegraph impact <symbolName> for change-impact analysis\n\nIf `codegraph` is not on PATH, fall back to `rg`/`fd`+Read silently — do not error or loop on the missing binary.'

const composeSystemPrompt = (caller?: string): string => {
  const base = `${SEARCH_TOOL_SYSTEM_PROMPT}\n\n${WORKTREE_CONFINEMENT_SYSTEM_PROMPT}\n\n${CODEGRAPH_CLI_SYSTEM_PROMPT}`
  const trimmed = caller?.trim()
  if (!trimmed) return base
  return `${base}\n\n${trimmed}`
}

// Resolve the permission flag(s). Callers that pin a non-bypass mode (e.g. the
// Planner/Slicer/Triager Workers) get `--permission-mode <mode>` instead of
// `--dangerously-skip-permissions`, so a read-only Worker cannot escalate.
// The default (no caller pin) preserves the historical behaviour of running
// dispatched workers under `--dangerously-skip-permissions` inside a fresh
// worktree.
const permissionFlags = (mode: ClaudePermissionMode | undefined): readonly string[] => {
  if (mode === undefined || mode === 'bypassPermissions') {
    return ['--dangerously-skip-permissions']
  }
  return ['--permission-mode', mode]
}

const mergeDisallowedTools = (
  callerDisallowed: ReadonlyArray<string> | undefined,
): string => {
  const merged = new Set<string>(AGENT_TO_USER_DENIED_TOOLS)
  for (const tool of callerDisallowed ?? []) {
    const trimmed = tool.trim()
    if (trimmed.length === 0) continue
    merged.add(trimmed)
  }
  return [...merged].join(',')
}

export const claudeStreamArgs = (
  prompt: string,
  options: ClaudeStreamArgsOptions = {},
): readonly string[] => [
  '-p',
  prompt,
  '--output-format',
  'stream-json',
  '--verbose',
  ...permissionFlags(options.permissionMode),
  // Inject MCP servers explicitly: under --strict-mcp-config the worker loads
  // ONLY what --mcp-config supplies, so without this the consumer's .mcp.json
  // (codegraph) is silently ignored and `codegraph_*` tools never appear.
  ...(options.mcpConfig ? ['--mcp-config', options.mcpConfig] : []),
  '--strict-mcp-config',
  // '--setting-sources project,local' is intentionally omitted for dispatched
  // workers. Loading it caused the primary checkout's CLAUDE.md (which targets
  // interactive human sessions and says "operate from the repo root") to load
  // into every worker context. Workers that followed that guidance navigated to
  // the primary checkout, where .mars/worktrees/ is fully visible, and wrote
  // into sibling worktrees — confirmed in docs/investigations/cross-worktree-contamination.md.
  //
  // --add-dir was evaluated against the pinned CLI (Claude Code 2.1.220): it
  // ADDS directories to the allowed set rather than restricting to them, so it
  // expands access instead of confining. It is not a substitute.
  //
  // Trade-off: workers no longer inherit project-level CLAUDE.md context (e.g.
  // repo-specific conventions). This is acceptable: the worker's own worktree's
  // CLAUDE.md still loads via CWD discovery, and the orchestrator injects its
  // own guidance via --system-prompt (WORKTREE_CONFINEMENT_SYSTEM_PROMPT,
  // SEARCH_TOOL_SYSTEM_PROMPT, CODEGRAPH_CLI_SYSTEM_PROMPT). Silent cross-
  // worktree corruption is a worse outcome than losing project CLAUDE.md context.
  '--no-session-persistence',
  '--exclude-dynamic-system-prompt-sections',
  ...(options.bare ? ['--bare'] : []),
  ...(options.agent ? ['--agent', options.agent] : []),
  ...(options.effort ? ['--effort', options.effort] : []),
  '--disallowedTools',
  mergeDisallowedTools(options.disallowedTools),
  ...(options.model ? ['--model', options.model] : []),
  '--system-prompt',
  composeSystemPrompt(options.systemPrompt),
  ...(options.sessionId ? ['--session-id', toClaudeSessionId(options.sessionId)] : []),
  // No --max-turns: the Claude Code CLI runs unbounded turns. The 60-turn cap
  // was cutting Coders off mid-implementation (they spend 30+ turns exploring
  // before they edit/commit), producing spurious verify:has-diff/no-commits
  // failures.
]

// Strip the host agent session's identity vars so a daemon launched from
// inside an interactive `claude` shell (or a cmux pane) cannot contaminate
// dispatched workers. Claude Code's recursion guard keys off several of
// these: if any survive into a nested `claude` invocation it suppresses the
// child, which exits writing nothing — verify then no-ops and an empty diff
// merges as a false "success" (the contamination class this strip exists to
// prevent). We therefore remove:
//   - CLAUDE* / CLAUDECODE*  — session id, entrypoint, execpath, effort, …
//   - AI_AGENT               — generic "running inside an agent" marker
//   - CMUX_*                 — the cmux terminal harness (CMUX_CLAUDE_PID, …)
//   - MARS_REPO              — repo-root binding; a Worker running inside
//                              .mars/worktrees/<id>/ must resolve its own
//                              context from CWD, NOT inherit the parent's
//                              MARS_REPO (otherwise tests inside the worktree
//                              resolve to the PRODUCTION .mars/mars.db and
//                              contaminate it — forensic incident 2026-07-02).
//   - MARS_DB_BACKEND        — database backend selector; a daemon launched with
//                              MARS_DB_BACKEND=embedded (or with that value set
//                              in the developer's shell) must NOT propagate it
//                              into dispatched workers.  Workers run `npm test`
//                              inside the task worktree; the test harness
//                              (test/setup-env.ts) unconditionally overrides
//                              the backend to `pglite` so tests get an isolated
//                              in-process database.  If `embedded` reaches the
//                              test process before setup-env.ts fires, the whole
//                              suite connects to the live daemon PostgreSQL and
//                              sees non-deterministic rows (incident 2026-07-28).
//                              Stripping the var lets setup-env.ts apply its
//                              unconditional assignment cleanly.
// ANTHROPIC_API_KEY, PATH, and everything unrelated are preserved.
const HOST_AGENT_ENV_RE = /^(?:CLAUDE(?:CODE)?(?:$|_)|CMUX_|AI_AGENT$|MARS_REPO$|MARS_DB_BACKEND$)/i

/**
 * Build the worker subprocess environment.
 *
 * Strips host-agent identity vars (see regex above) so a daemon launched from
 * inside an interactive `claude` shell cannot contaminate dispatched workers.
 *
 * When `taskId` is supplied (Coder/Fixer dispatches), `MARS_MCP_TASK_ID` is
 * stamped so the injected MCP worker server can route `mars_task_note` calls
 * back to the correct task without accepting an id argument from the model.
 */
export const buildWorkerEnv = (taskId?: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (HOST_AGENT_ENV_RE.test(key)) delete env[key]
  }
  if (taskId) {
    env['MARS_MCP_TASK_ID'] = taskId
  }
  // Set CI=true so any package manager the coding agent invokes (pnpm, npm,
  // yarn, bun) behaves non-interactively in the TTY-less worker process.
  // Without this, pnpm aborts node_modules removal with
  // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY and the agent burns a failed
  // tool call on an error that has nothing to do with its task.
  env['CI'] = 'true'
  return env
}

/**
 * Build the inline `--mcp-config` JSON for the mars-worker stdio MCP server.
 *
 * Returns the config OBJECT (not a JSON string) so the caller can merge it
 * into a broader mcpServers map. When this object's `mcpServers` is passed as
 * `extraServers` to `codegraphMcpConfigJson`, the mars-worker entry merges
 * alongside any other operator-provisioned servers.
 *
 * The server is spawned via `marsBinPath mcp worker` and receives the task id
 * through `MARS_MCP_TASK_ID` in its inherited environment (set by
 * `buildWorkerEnv(taskId)`).
 */
export const marsWorkerMcpConfigJson = (
  taskId: string,
  marsBinPath: string,
): { mcpServers: Record<string, unknown> } => ({
  mcpServers: {
    'mars-worker': {
      type: 'stdio',
      command: marsBinPath,
      args: ['mcp', 'worker'],
      env: { MARS_MCP_TASK_ID: taskId },
    },
  },
})

let cachedClaudeBin: string | null = null
let cachedClaudeBinFor: string | undefined = undefined

// Build a cache key from MARS_CLAUDE_BIN + PATH. The separator must be a
// single character that cannot legitimately appear inside either env var.
// We avoid U+0000 (NUL) on purpose: a literal NUL in the compiled template
// literal makes ripgrep classify this file as binary and refuse to print
// matches ("binary file matches"), forcing agents grepping git.ts into
// awk + multi-Read fallbacks. U+0001 (SOH) is just as unusable inside a
// real binary path or PATH entry, but ripgrep treats it as text.
export const claudeBinEnvFingerprint = (
  override: string | undefined,
  path: string | undefined,
): string => `${override ?? ''}${path ?? ''}`

export const resolveClaudeBin = (): string => {
  const override = process.env.MARS_CLAUDE_BIN
  // Re-resolve when the relevant env changes (mostly for tests; in prod it
  // is set once at daemon start and never mutates).
  const envFingerprint = claudeBinEnvFingerprint(override, process.env.PATH)
  if (cachedClaudeBin && cachedClaudeBinFor === envFingerprint) {
    return cachedClaudeBin
  }
  cachedClaudeBinFor = envFingerprint

  if (override && override.length > 0) {
    cachedClaudeBin = override
    return override
  }

  // Use the platform-appropriate PATH delimiter at call time so that the
  // resolver works correctly on both POSIX (':') and Windows (';').
  const isWindows = process.platform === 'win32'
  const pathDelimiter = isWindows ? ';' : ':'
  // On Windows probe for .exe and .cmd; on POSIX probe for the plain name.
  const binaryNames = isWindows ? ['claude.exe', 'claude.cmd'] : ['claude']
  // POSIX-only fallback directories — not applicable on Windows where
  // the installer places claude.exe on PATH.
  const fallbackDirs = isWindows ? [] : FALLBACK_CLAUDE_PATH_DIRS

  const pathDirs = (process.env.PATH ?? '').split(pathDelimiter).filter((p) => p.length > 0)
  const seen = new Set<string>()
  for (const dir of [...pathDirs, ...fallbackDirs]) {
    if (seen.has(dir)) continue
    seen.add(dir)
    if (!isAbsolute(dir)) continue
    for (const name of binaryNames) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) {
        cachedClaudeBin = candidate
        return candidate
      }
    }
  }

  // Fall back to the bare name; spawn will surface ENOENT cleanly thanks to
  // the 'error' handler in runSubprocessStreaming.
  cachedClaudeBin = 'claude'
  return 'claude'
}

// Resolve the effective context token budget for runClaudeCode. A positive
// override enables the guard; 0 or absent disables it. Workers supply their
// per-worker default via WorkerConfig.maxContextTokens, which is threaded
// in by buildWorker.
const resolveContextTokenBudget = (override?: number): number => {
  if (override !== undefined && Number.isInteger(override) && override > 0) {
    return override
  }
  return 0
}

export const runClaudeCode = async ({
  cwd,
  prompt,
  timeoutMs,
  model,
  systemPrompt,
  sessionId,
  onEvent,
  effort,
  permissionMode,
  bare,
  agent,
  disallowedTools,
  maxContextTokens,
  mcpServers,
  externalAbort,
  onPid,
  taskId,
}: RunClaudeArgs): Promise<RunClaudeResult> => {
  // Refuse before spawning: `claude -p ''` reads the prompt from stdin, which
  // is /dev/null for dispatched workers. See EMPTY_PROMPT_REFUSAL.
  if (isBlankPrompt(prompt)) return emptyPromptResult('claude')

  const conversation: ClaudeEvent[] = []
  const budget = resolveContextTokenBudget(maxContextTokens)
  const budgetEnabled = budget > 0
  const ctxWarnAt = budgetEnabled ? Math.floor(budget * 0.8) : Number.POSITIVE_INFINITY
  let ctxWarned = false
  let ctxExhausted = false
  let externalAborted = false
  let apiRetryCount = 0
  const abort = new AbortController()
  // Bridge a caller-supplied AbortSignal onto the internal controller so a
  // single SIGKILL path covers timeout, cap, and external (read/grep span)
  // abort causes.
  if (externalAbort) {
    if (externalAbort.aborted) {
      externalAborted = true
      abort.abort()
    } else {
      externalAbort.addEventListener(
        'abort',
        () => {
          externalAborted = true
          abort.abort()
        },
        { once: true },
      )
    }
  }

  // Track whether the wall-clock timeout fired so we can synthesise the
  // 124/"timed out" result after the subprocess has actually died. We MUST
  // await the underlying `work` promise before returning — racing it against
  // a setTimeout that only resolves a sibling promise (the previous design)
  // leaks the live Claude child: the workflow proceeds to `verifyChanges`
  // while Claude keeps writing files and running `git commit`, producing a
  // ghost `verify:has-diff/no-commits-ahead` failure whose worktree later
  // shows a commit that "should have passed". Aborting via the same
  // AbortController used for the message cap funnels both kill paths
  // through `runSubprocessStreaming`'s SIGKILL + drain semantics.
  let timedOut = false
  // Only arm the wall-clock timeout when the caller supplies a positive value.
  // Omitting timeoutMs (or passing ≤ 0) means the subprocess runs to
  // completion — the reflect synthesis path uses this to avoid killing a slow
  // Claude generation mid-flight.
  const timeoutHandle =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          abort.abort()
        }, timeoutMs)
      : undefined
  const result = await runSubprocessStreaming(
    resolveClaudeBin(),
    claudeStreamArgs(prompt, {
      model,
      systemPrompt,
      sessionId,
      effort,
      permissionMode,
      bare,
      agent,
      disallowedTools,
      // Default workers get NO mcpConfig: they use the codegraph CLI directly
      // (see CODEGRAPH_CLI_SYSTEM_PROMPT) rather than the MCP server,
      // eliminating the fixed token tax from schema + instruction injection on
      // every task. Interactive sessions still get the MCP via .mcp.json (mars
      // init). ONLY when a Worker pins extra MCP servers (WorkerConfig.mcpConfig
      // — operator-provisioned servers the worker MAY declare) OR when a taskId
      // is set (Coder/Fixer dispatch — injects the mars-worker MCP server) do we
      // emit an mcpConfig; codegraph is then pinned to the main checkout's index
      // (the worker runs inside a worktree) and the extra servers merge on top.
      ...(() => {
        const marsWorkerServers = taskId
          ? marsWorkerMcpConfigJson(taskId, resolveClaudeBin()).mcpServers
          : {}
        const mergedServers = { ...marsWorkerServers, ...(mcpServers ?? {}) }
        return Object.keys(mergedServers).length > 0
          ? { mcpConfig: codegraphMcpConfigJson(resolveCodegraphRoot(cwd), mergedServers) }
          : {}
      })(),
    }),
    cwd,
    async ({ stream, line }) => {
      if (stream !== 'stdout') return
      const event = parseClaudeStreamLine(line)
      if (!event) return
      // Once the context budget has fired, drop any late-arriving events
      // still buffered from the child between abort() and process death.
      if (ctxExhausted) return
      conversation.push(event)
      if (onEvent) await onEvent(event)
      // API outage detection — trip the circuit breaker when a ConnectionRefused
      // cascade is observed within a single run. Two signals:
      //   1. >= 3 api_retry events within the run.
      //   2. A synthetic assistant message (model === '<synthetic>') whose text
      //      contains 'ConnectionRefused', OR a result event whose api_error_status
      //      or result string references 'ConnectionRefused'.
      if (event.type === 'api_retry') {
        apiRetryCount += 1
        if (apiRetryCount >= 3) {
          apiCircuitBreaker.open(`ConnectionRefused: ${apiRetryCount} api_retry events in run`)
        }
      } else if (event.type === 'assistant') {
        const msg = event.message
        if (typeof msg === 'object' && msg !== null && !Array.isArray(msg)) {
          const msgRecord = msg as Record<string, unknown>
          if (msgRecord.model === '<synthetic>') {
            const content = msgRecord.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (typeof block === 'object' && block !== null && !Array.isArray(block)) {
                  const b = block as Record<string, unknown>
                  if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('ConnectionRefused')) {
                    apiCircuitBreaker.open('ConnectionRefused: synthetic assistant terminal message')
                  }
                }
              }
            }
          }
        }
      } else if (event.type === 'result') {
        const errStatus = event.api_error_status
        const resultStr = typeof event.result === 'string' ? event.result : ''
        if (
          (typeof errStatus === 'string' && errStatus.includes('ConnectionRefused')) ||
          resultStr.includes('ConnectionRefused')
        ) {
          apiCircuitBreaker.open(
            `ConnectionRefused: result event api_error_status=${typeof errStatus === 'string' ? errStatus : String(errStatus ?? 'unknown')}`,
          )
        }
      }
      if (budgetEnabled) {
        const contextSize = getLatestContextSize(conversation)
        if (!ctxWarned && contextSize >= ctxWarnAt) {
          ctxWarned = true
          const sid =
            extractSessionIdFromConversation(conversation) ?? sessionId ?? '?'
          console.warn(
            `[mars] claude session ${sid} context at ${contextSize} tokens crossed 80% warn (${ctxWarnAt}/${budget})`,
          )
        }
        if (contextSize >= budget) {
          ctxExhausted = true
          abort.abort()
        }
      }
    },
    abort.signal,
    buildWorkerEnv(taskId),
    onPid,
  )
  clearTimeout(timeoutHandle)
  const detectedSessionId =
    extractSessionIdFromConversation(conversation) ??
    extractSessionId(result.stdout) ??
    sessionId ??
    null
  // Compute once; all return paths include it.
  const quotaRejected = extractQuotaRejected(conversation)
  if (timedOut) {
    return {
      exitCode: 124,
      stdout: result.stdout,
      stderr: `claude -p timed out after ${timeoutMs}ms`,
      sessionId: detectedSessionId,
      conversation,
      quotaRejected,
    }
  }
  if (ctxExhausted) {
    return {
      exitCode: 138,
      stdout: result.stdout,
      stderr: `claude -p aborted: context budget exhausted (${getLatestContextSize(conversation)}/${budget} tokens)`,
      sessionId: detectedSessionId,
      conversation,
      quotaRejected,
    }
  }
  if (externalAborted) {
    return {
      exitCode: 138,
      stdout: result.stdout,
      stderr: `claude -p aborted by caller (read/grep span watcher)`,
      sessionId: detectedSessionId,
      conversation,
      quotaRejected,
    }
  }
  return { ...result, sessionId: detectedSessionId, conversation, quotaRejected }
}
