import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { constants as fsConstants } from 'node:fs'
import { parseClaudeStreamLine, type ClaudeEvent } from '../claude-stream'
import { getLatestContextSize } from '../claude-usage'
import { FALLBACK_CLAUDE_PATH_DIRS, isExecutableFile } from './internal'

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

// SIGKILL every tracked child. Best-effort: a PID that has already exited or
// that the process lacks permission to signal is silently skipped. Returns
// the list of PIDs we attempted to kill.
export const killAllChildren = (): readonly number[] => {
  const killed: number[] = []
  for (const pid of liveChildPids) {
    try {
      process.kill(pid, 'SIGKILL')
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
): Promise<RunSubprocessResult> =>
  new Promise((resolveFn) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (typeof child.pid === 'number') liveChildPids.add(child.pid)
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
      if (!child.killed) child.kill('SIGKILL')
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
    // 'error' on the ChildProcess and never fires 'close'. Without this
    // listener Node treats it as an unhandled 'error' event and crashes
    // the entire daemon process.
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (typeof child.pid === 'number') liveChildPids.delete(child.pid)
      const detail = err.code ? `${err.code}: ${err.message}` : err.message
      settle({
        exitCode: err.code === 'ENOENT' ? 127 : 1,
        stdout,
        stderr: stderr + (stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n') + `spawn ${cmd} ${detail}`,
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
   * Optional caller-supplied abort signal. When fired, runClaudeCode
   * SIGKILLs the child and returns a `exitCode: 137` result. Used by the
   * read/grep span watcher to terminate sessions that have stalled on
   * reads. The signal is ORed with the internal timeout abort, so either
   * side can trigger termination.
   */
  externalAbort?: AbortSignal
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
}

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
}

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

const composeSystemPrompt = (caller?: string): string => {
  const trimmed = caller?.trim()
  if (!trimmed) return SEARCH_TOOL_SYSTEM_PROMPT
  return `${SEARCH_TOOL_SYSTEM_PROMPT}\n\n${trimmed}`
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
  '--strict-mcp-config',
  '--setting-sources',
  'project,local',
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
// ANTHROPIC_API_KEY, PATH, and everything unrelated are preserved.
const HOST_AGENT_ENV_RE = /^(?:CLAUDE(?:CODE)?(?:$|_)|CMUX_|AI_AGENT$)/i
export const buildWorkerEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (HOST_AGENT_ENV_RE.test(key)) delete env[key]
  }
  return env
}

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
  externalAbort,
}: RunClaudeArgs): Promise<RunClaudeResult> => {
  const conversation: ClaudeEvent[] = []
  const budget = resolveContextTokenBudget(maxContextTokens)
  const budgetEnabled = budget > 0
  const ctxWarnAt = budgetEnabled ? Math.floor(budget * 0.8) : Number.POSITIVE_INFINITY
  let ctxWarned = false
  let ctxExhausted = false
  let externalAborted = false
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
    buildWorkerEnv(),
  )
  clearTimeout(timeoutHandle)
  const detectedSessionId =
    extractSessionIdFromConversation(conversation) ??
    extractSessionId(result.stdout) ??
    sessionId ??
    null
  if (timedOut) {
    return {
      exitCode: 124,
      stdout: result.stdout,
      stderr: `claude -p timed out after ${timeoutMs}ms`,
      sessionId: detectedSessionId,
      conversation,
    }
  }
  if (ctxExhausted) {
    return {
      exitCode: 138,
      stdout: result.stdout,
      stderr: `claude -p aborted: context budget exhausted (${getLatestContextSize(conversation)}/${budget} tokens)`,
      sessionId: detectedSessionId,
      conversation,
    }
  }
  if (externalAborted) {
    return {
      exitCode: 138,
      stdout: result.stdout,
      stderr: `claude -p aborted by caller (read/grep span watcher)`,
      sessionId: detectedSessionId,
      conversation,
    }
  }
  return { ...result, sessionId: detectedSessionId, conversation }
}
