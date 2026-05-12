import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname, isAbsolute, join } from 'node:path'
import { open, mkdir, readFile, rm, unlink } from 'node:fs/promises'
import { statSync, constants as fsConstants, accessSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getRepoRoot, getStateDir } from '../context'
import { parseClaudeStreamLine, type ClaudeEvent } from './claude-stream'

const exec = promisify(execFile)

const repoRoot = (): string => getRepoRoot()
const moduleDir = (): string => dirname(fileURLToPath(import.meta.url))

export interface CreateWorktreeArgs {
  taskId: string
  integrationBranch: string
  baseSha?: string
  branchSuffix?: string
}

export interface WorktreeRef {
  path: string
  branch: string
}

interface RegisteredWorktree {
  path: string
  branch: string | null
}

const listRegisteredWorktrees = async (): Promise<RegisteredWorktree[]> => {
  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot(),
  })
  const entries: RegisteredWorktree[] = []
  let current: { path?: string; branch?: string | null } = {}
  const flush = (): void => {
    if (current.path) {
      entries.push({ path: current.path, branch: current.branch ?? null })
    }
    current = {}
  }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref
    } else if (line.startsWith('detached')) {
      current.branch = null
    } else if (line.length === 0) {
      flush()
    }
  }
  flush()
  return entries
}

const branchExists = async (branch: string): Promise<boolean> => {
  try {
    await exec(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { cwd: repoRoot() },
    )
    return true
  } catch {
    return false
  }
}

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await exec('test', ['-e', p])
    return true
  } catch {
    return false
  }
}

export const createWorktree = async ({
  taskId,
  integrationBranch,
  baseSha,
  branchSuffix,
}: CreateWorktreeArgs): Promise<WorktreeRef> => {
  const suffix = branchSuffix ? `-${branchSuffix}` : ''
  const branch = `task/${taskId}${suffix}`
  const dirName = `${taskId}${suffix}`
  const path = resolve(getStateDir(), `worktrees/${dirName}`)
  const startPoint = baseSha ?? integrationBranch
  const cwd = repoRoot()

  await mkdir(resolve(path, '..'), { recursive: true })

  // Prune any stale worktree registrations (paths recorded in .git/worktrees
  // that no longer exist on disk) before inspecting state.
  await exec('git', ['worktree', 'prune'], { cwd }).catch(() => {})

  const registered = await listRegisteredWorktrees().catch(
    () => [] as RegisteredWorktree[],
  )
  const existingForBranch = registered.find((w) => w.branch === branch)
  const existingForPath = registered.find((w) => w.path === path)

  // Already-registered worktree at the expected path on the expected branch:
  // reuse it as-is. This is the "skip if it already exists" path.
  if (
    existingForBranch &&
    existingForPath &&
    existingForBranch.path === existingForPath.path &&
    (await pathExists(path))
  ) {
    return { path, branch }
  }

  // Worktree registered at our path but on a different branch (or detached).
  // It's stale state from a previous run — drop it.
  if (existingForPath && existingForPath.branch !== branch) {
    await exec(
      'git',
      ['worktree', 'remove', '--force', existingForPath.path],
      { cwd },
    ).catch(() => {})
  }

  // Worktree registered for our branch at a different path. Drop that
  // registration so we can re-attach the branch at the canonical path.
  if (existingForBranch && existingForBranch.path !== path) {
    await exec(
      'git',
      ['worktree', 'remove', '--force', existingForBranch.path],
      { cwd },
    ).catch(() => {})
  }

  // Re-prune in case the removes above left dangling refs.
  await exec('git', ['worktree', 'prune'], { cwd }).catch(() => {})

  // If a directory still exists at our target path with no live worktree
  // registration, it's leftover filesystem state — wipe it.
  if (await pathExists(path)) {
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }

  const branchAlreadyExists = await branchExists(branch)
  const args = branchAlreadyExists
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, startPoint]
  await exec('git', args, { cwd })
  return { path, branch }
}

export const resolveSha = async (ref: string): Promise<string> => {
  const { stdout } = await exec('git', ['rev-parse', ref], { cwd: repoRoot() })
  return stdout.trim()
}

export const removeWorktree = async (
  ref: WorktreeRef,
  force = true,
  keepBranch = false,
): Promise<void> => {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(ref.path)
  await exec('git', args, { cwd: repoRoot() })
  if (!keepBranch) {
    await exec('git', ['branch', '-D', ref.branch], { cwd: repoRoot() }).catch(() => {})
  }
}

export interface RunSubprocessResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SubprocessLine {
  stream: 'stdout' | 'stderr'
  line: string
}

export const runSubprocessStreaming = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  onLine?: (event: SubprocessLine) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<RunSubprocessResult> =>
  new Promise((resolveFn) => {
    const child = spawn(cmd, args, { cwd, env: process.env })
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
      const detail = err.code ? `${err.code}: ${err.message}` : err.message
      settle({
        exitCode: err.code === 'ENOENT' ? 127 : 1,
        stdout,
        stderr: stderr + (stderr.endsWith('\n') || stderr.length === 0 ? '' : '\n') + `spawn ${cmd} ${detail}`,
      })
    })
    child.on('close', (code) => {
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
  timeoutMs: number
  model?: string
  systemPrompt?: string
  sessionId?: string
  onEvent?: (event: ClaudeEvent) => void | Promise<void>
}

export interface RunClaudeResult extends RunSubprocessResult {
  sessionId: string | null
  conversation: ClaudeEvent[]
}

const extractSessionIdFromConversation = (
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
}

// Agent-to-user tools denied for every dispatched Session. No human is
// listening on a dispatched run, so a call to either tool errors at the
// claude runtime and tempts the agent to silently drift from the task.
// Denying them at the single shared wrapper means every workflow — including
// paths that legitimately bypass the Worker primitive (e.g. A/B experiment)
// — inherits the ban. See idea 948691d0.
const AGENT_TO_USER_DENIED_TOOLS = ['AskUserQuestion', 'SendUserMessage'] as const

export const claudeStreamArgs = (
  prompt: string,
  options: ClaudeStreamArgsOptions = {},
): readonly string[] => [
  '-p',
  prompt,
  '--output-format',
  'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  '--disallowedTools',
  AGENT_TO_USER_DENIED_TOOLS.join(','),
  ...(options.model ? ['--model', options.model] : []),
  ...(options.systemPrompt ? ['--system-prompt', options.systemPrompt] : []),
  ...(options.sessionId ? ['--session-id', options.sessionId] : []),
]

const DEFAULT_CLAUDE_MAX_MESSAGES = 100

// Default search path for the `claude` binary when it is not on the daemon's
// PATH (e.g. detached / launchd contexts strip everything but a minimal PATH).
const FALLBACK_CLAUDE_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
]

const isExecutableFile = (path: string): boolean => {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

let cachedClaudeBin: string | null = null
let cachedClaudeBinFor: string | undefined = undefined

const resolveClaudeBin = (): string => {
  const override = process.env.MARS_CLAUDE_BIN
  // Re-resolve when the relevant env changes (mostly for tests; in prod it
  // is set once at daemon start and never mutates).
  const envFingerprint = `${override ?? ''}\0${process.env.PATH ?? ''}`
  if (cachedClaudeBin && cachedClaudeBinFor === envFingerprint) {
    return cachedClaudeBin
  }
  cachedClaudeBinFor = envFingerprint

  if (override && override.length > 0) {
    cachedClaudeBin = override
    return override
  }

  const pathDirs = (process.env.PATH ?? '').split(':').filter((p) => p.length > 0)
  const seen = new Set<string>()
  for (const dir of [...pathDirs, ...FALLBACK_CLAUDE_PATH_DIRS]) {
    if (seen.has(dir)) continue
    seen.add(dir)
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, 'claude')
    if (isExecutableFile(candidate)) {
      cachedClaudeBin = candidate
      return candidate
    }
  }

  // Fall back to the bare name; spawn will surface ENOENT cleanly thanks to
  // the 'error' handler in runSubprocessStreaming.
  cachedClaudeBin = 'claude'
  return 'claude'
}

const resolveClaudeMessageCap = (): number => {
  const raw = process.env.MARS_CLAUDE_MAX_MESSAGES
  if (raw === undefined) return DEFAULT_CLAUDE_MAX_MESSAGES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_CLAUDE_MAX_MESSAGES
  return parsed
}

export const runClaudeCode = async ({
  cwd,
  prompt,
  timeoutMs,
  model,
  systemPrompt,
  sessionId,
  onEvent,
}: RunClaudeArgs): Promise<RunClaudeResult> => {
  const conversation: ClaudeEvent[] = []
  const cap = resolveClaudeMessageCap()
  const capEnabled = cap > 0
  const warnAt = capEnabled ? Math.floor(cap * 0.6) : Number.POSITIVE_INFINITY
  let warned = false
  let capHit = false
  const abort = new AbortController()

  const work = runSubprocessStreaming(
    resolveClaudeBin(),
    claudeStreamArgs(prompt, { model, systemPrompt, sessionId }),
    cwd,
    async ({ stream, line }) => {
      if (stream !== 'stdout') return
      const event = parseClaudeStreamLine(line)
      if (!event) return
      // Once the cap has fired, drop any late-arriving events still buffered
      // from the child between abort() and process death. The conversation
      // length must equal exactly `cap` for cap-hit runs.
      if (capHit) return
      conversation.push(event)
      if (onEvent) await onEvent(event)
      if (!capEnabled) return
      if (!warned && conversation.length === warnAt) {
        warned = true
        const sid =
          extractSessionIdFromConversation(conversation) ?? sessionId ?? '?'
        console.warn(
          `[mars] claude session ${sid} crossed ${warnAt} messages (cap ${cap})`,
        )
      }
      if (conversation.length >= cap) {
        capHit = true
        abort.abort()
      }
    },
    abort.signal,
  )
  const timeout = new Promise<RunSubprocessResult>((resolveFn) =>
    setTimeout(
      () =>
        resolveFn({
          exitCode: 124,
          stdout: '',
          stderr: `claude -p timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    ),
  )
  const result = await Promise.race([work, timeout])
  const detectedSessionId =
    extractSessionIdFromConversation(conversation) ??
    extractSessionId(result.stdout) ??
    sessionId ??
    null
  if (capHit) {
    return {
      exitCode: 137,
      stdout: result.stdout,
      stderr: `claude -p hit message cap of ${cap} (MARS_CLAUDE_MAX_MESSAGES)`,
      sessionId: detectedSessionId,
      conversation,
    }
  }
  return { ...result, sessionId: detectedSessionId, conversation }
}

export interface VerifyStep {
  name: string
  passed: boolean
  output: string
}

export interface VerifyStepSpec {
  name: string
  cmd: string
  args: readonly string[]
  required: boolean
}

export interface VerifyArgs {
  cwd: string
  steps: ReadonlyArray<VerifyStepSpec>
  branch?: string
  integrationBranch?: string
}

const runVerifyStep = async (
  name: string,
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<VerifyStep> => {
  try {
    const { stdout, stderr } = await exec(cmd, [...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    })
    return { name, passed: true, output: stdout + stderr }
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    return {
      name,
      passed: false,
      output: (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? ''),
    }
  }
}

export const checkBranchHasDiff = async (
  cwd: string,
  branch: string,
  integrationBranch: string,
): Promise<VerifyStep> => {
  try {
    const { stdout } = await exec(
      'git',
      ['rev-list', '--count', `${integrationBranch}..${branch}`],
      { cwd },
    )
    const count = Number.parseInt(stdout.trim(), 10)
    if (!Number.isInteger(count) || count <= 0) {
      // Distinguish "branch tip is strictly behind integration" (work
      // already shipped — fast-forward merged it into main between this
      // task's setup and this check) from "branch tip equals integration"
      // (genuine no-op — agent set up the worktree and didn't commit).
      // Only the latter is a failure.
      const branchSha = (await exec('git', ['rev-parse', '--verify', `${branch}^{commit}`], { cwd })).stdout.trim()
      const integrationSha = (await exec('git', ['rev-parse', '--verify', `${integrationBranch}^{commit}`], { cwd })).stdout.trim()
      if (branchSha !== integrationSha) {
        return {
          name: 'has-diff',
          passed: true,
          output: `branch ${branch} is an ancestor of ${integrationBranch} — work already merged`,
        }
      }
      return {
        name: 'has-diff',
        passed: false,
        output: 'no commits ahead of integration branch — task did not produce any changes',
      }
    }
    return { name: 'has-diff', passed: true, output: `${count} commit(s) ahead of ${integrationBranch}` }
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    return {
      name: 'has-diff',
      passed: false,
      output: `git rev-list failed: ${(e.stderr ?? '') + (e.message ?? '')}`,
    }
  }
}

export const verifyChanges = async (
  args: VerifyArgs,
): Promise<{ passed: boolean; steps: VerifyStep[] }> => {
  if (args.branch && args.integrationBranch) {
    const diffStep = await checkBranchHasDiff(args.cwd, args.branch, args.integrationBranch)
    if (!diffStep.passed) {
      return { passed: false, steps: [diffStep] }
    }
  }

  const results: VerifyStep[] = []
  let stoppedOnRequired = false
  for (const spec of args.steps) {
    if (stoppedOnRequired && spec.required) continue
    const result = await runVerifyStep(spec.name, spec.cmd, spec.args, args.cwd)
    results.push(result)
    if (!result.passed && spec.required) {
      stoppedOnRequired = true
    }
  }

  const requiredFailed = args.steps.some((spec, i) => {
    const r = results[i]
    return spec.required && r && !r.passed
  })
  return { passed: !requiredFailed && !stoppedOnRequired, steps: results }
}

const DEFAULT_VERIFY_STEPS: VerifyStepSpec[] = [
  { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
  { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
  { name: 'lint', cmd: 'npx', args: ['biome', 'check', '.'], required: true },
]

interface ManifestSupervisorEntry {
  name?: string
  scope?: string
  verify?: ReadonlyArray<{
    name: string
    cmd: string
    args: readonly string[]
    required?: boolean
  }>
}

interface SupervisorsManifest {
  supervisors?: ReadonlyArray<ManifestSupervisorEntry>
}

const scopeDepth = (scope: string | undefined): number => {
  if (!scope || scope === '.' || scope === '') return 0
  return scope.split('/').filter(Boolean).length
}

export const loadVerifySteps = async (
  manifestPath: string,
): Promise<VerifyStepSpec[]> => {
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [...DEFAULT_VERIFY_STEPS]
    }
    throw error
  }
  let parsed: SupervisorsManifest
  try {
    parsed = JSON.parse(raw) as SupervisorsManifest
  } catch {
    return [...DEFAULT_VERIFY_STEPS]
  }
  const supervisors = parsed.supervisors ?? []
  const byName = new Map<string, { spec: VerifyStepSpec; depth: number }>()
  for (const sup of supervisors) {
    const verify = sup.verify
    if (!verify || verify.length === 0) continue
    const depth = scopeDepth(sup.scope)
    for (const v of verify) {
      const spec: VerifyStepSpec = {
        name: v.name,
        cmd: v.cmd,
        args: [...v.args],
        required: v.required ?? true,
      }
      const existing = byName.get(v.name)
      if (!existing || depth < existing.depth) {
        byName.set(v.name, { spec, depth })
      }
    }
  }
  if (byName.size === 0) return [...DEFAULT_VERIFY_STEPS]
  return Array.from(byName.values()).map((e) => e.spec)
}

export const DEFAULT_VERIFY_STEPS_FALLBACK: ReadonlyArray<VerifyStepSpec> =
  DEFAULT_VERIFY_STEPS

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // EPERM means the process exists but we don't have permission to signal it.
    if (code === 'EPERM') return true
    return false
  }
}

const isLockStale = async (lockPath: string): Promise<boolean> => {
  try {
    const contents = (await readFile(lockPath, 'utf8')).trim()
    if (!contents) return true
    const pid = Number.parseInt(contents, 10)
    if (!Number.isInteger(pid) || pid <= 0) return true
    if (pid === process.pid) return true
    return !isPidAlive(pid)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    // The lock vanished between our failed open and the read — treat as stale
    // so the next open attempt can claim it.
    if (code === 'ENOENT') return true
    return false
  }
}

export const acquireLock = async (
  lockPath: string,
  timeoutMs: number,
): Promise<() => Promise<void>> => {
  await mkdir(resolve(lockPath, '..'), { recursive: true })
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const handle = await open(lockPath, 'wx')
      await handle.write(String(process.pid))
      return async () => {
        await handle.close()
        await unlink(lockPath).catch(() => {})
      }
    } catch {
      // If the existing lock's owner is dead (or the file is empty/corrupt),
      // reclaim it. The retry loop handles TOCTOU: if another process beats
      // us to unlink+open, our next `open(..., 'wx')` simply fails and we
      // fall back to polling.
      if (await isLockStale(lockPath)) {
        await unlink(lockPath).catch(() => {})
        continue
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error(`Failed to acquire merge lock after ${timeoutMs}ms`)
}

export type MergeTargetStatus =
  | { kind: 'clean' }
  | { kind: 'dirty'; targetPath: string; statusOutput: string }
  | { kind: 'error'; error: Error }

export const checkMergeTargetStatus = async (): Promise<MergeTargetStatus> => {
  const targetPath = repoRoot()
  try {
    const { stdout } = await exec('git', ['status', '--porcelain'], {
      cwd: targetPath,
    })
    if (stdout.length === 0) return { kind: 'clean' }
    return { kind: 'dirty', targetPath, statusOutput: stdout }
    // TODO(merge_target_missing): also surface a 'missing' kind when the
    // merge target branch has been deleted/renamed; for now any unexpected
    // git failure is reported as 'error'.
  } catch (error: unknown) {
    return {
      kind: 'error',
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export interface MergeArgs {
  branch: string
  worktreePath: string
  integrationBranch: string
  lockTimeoutMs: number
  onSupervisorEvent?: (event: ClaudeEvent) => void | Promise<void>
}

export interface MergeResult {
  merged: boolean
  conflictResolved: boolean
  aborted: boolean
  output: string
  supervisorConversation: ClaudeEvent[]
}

let cachedSupervisorSpec: string | null = null

export const stripFrontmatter = (text: string): string => {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return text
  const afterOpening = text.indexOf('\n') + 1
  const closingMatch = text.slice(afterOpening).match(/^---(\r?\n|$)/m)
  if (!closingMatch || closingMatch.index === undefined) return text
  const closingEnd = afterOpening + closingMatch.index + closingMatch[0].length
  return text.slice(closingEnd).replace(/^\r?\n+/, '')
}

const loadSupervisorSpec = async (): Promise<string> => {
  if (cachedSupervisorSpec) return cachedSupervisorSpec
  const candidates = [
    resolve(moduleDir(), '../public/prompts/vcs-supervisor.md'),
    resolve(moduleDir(), './prompts/vcs-supervisor.md'),
  ]
  for (const candidate of candidates) {
    try {
      cachedSupervisorSpec = await readFile(candidate, 'utf8')
      return cachedSupervisorSpec
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new Error(
    `vcs-supervisor.md not found; checked: ${candidates.join(', ')}`,
  )
}

const buildSupervisorPrompt = async (
  branch: string,
  integrationBranch: string,
): Promise<string> => {
  const spec = stripFrontmatter(await loadSupervisorSpec())
  return `${spec}

# Dispatch

Mode: rebase
Source: ${branch}
Target: ${integrationBranch}

A \`git rebase ${integrationBranch}\` of ${branch} just conflicted in this worktree. The rebase is in progress (\`.git/rebase-merge/\` or \`.git/rebase-apply/\` exists). Your cwd IS the worktree — do not \`cd\` elsewhere.

Resolve every conflict per your protocol — read both sides, reconcile intent, never blindly pick ours/theirs. After staging each step, use \`git rebase --continue\` (NOT \`git commit\`). Repeat until the rebase finishes. Then run verification.

Verification commands:
- typecheck: \`npx tsc --noEmit\`
- tests: \`npm test --silent\`
- lint: \`npx biome check .\`

End with the Completion Report block exactly as specified above.`
}

interface InvokeSupervisorResult extends RunSubprocessResult {
  conversation: ClaudeEvent[]
}

const invokeVcsSupervisor = async (
  branch: string,
  integrationBranch: string,
  cwd: string,
  timeoutMs: number,
  onEvent?: (event: ClaudeEvent) => void | Promise<void>,
): Promise<InvokeSupervisorResult> => {
  const prompt = await buildSupervisorPrompt(branch, integrationBranch)
  const conversation: ClaudeEvent[] = []
  const work = runSubprocessStreaming(
    resolveClaudeBin(),
    claudeStreamArgs(prompt),
    cwd,
    async ({ stream, line }) => {
      if (stream !== 'stdout') return
      const event = parseClaudeStreamLine(line)
      if (!event) return
      conversation.push(event)
      if (onEvent) await onEvent(event)
    },
  )
  const timeout = new Promise<RunSubprocessResult>((resolveFn) =>
    setTimeout(
      () =>
        resolveFn({
          exitCode: 124,
          stdout: '',
          stderr: `vcs-supervisor timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    ),
  )
  const result = await Promise.race([work, timeout])
  return { ...result, conversation }
}

const isRebaseInProgress = async (cwd: string): Promise<boolean> => {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--git-path', 'rebase-merge'], { cwd })
    const mergePath = stdout.trim()
    const { stdout: applyStdout } = await exec('git', ['rev-parse', '--git-path', 'rebase-apply'], { cwd })
    const applyPath = applyStdout.trim()
    const checks = await Promise.all([
      exec('test', ['-d', mergePath]).then(() => true).catch(() => false),
      exec('test', ['-d', applyPath]).then(() => true).catch(() => false),
    ])
    return checks.some(Boolean)
  } catch {
    return false
  }
}

export const mergeBranch = async ({
  branch,
  worktreePath,
  integrationBranch,
  lockTimeoutMs,
  onSupervisorEvent,
}: MergeArgs): Promise<MergeResult> => {
  const release = await acquireLock(
    resolve(getStateDir(), '.merge.lock'),
    lockTimeoutMs,
  )
  try {
    let output = ''
    let conflictResolved = false
    const supervisorConversation: ClaudeEvent[] = []

    // Step 1: ensure the task branch is up-to-date with integration via rebase
    // inside the worktree. After this, integration can fast-forward to it.
    try {
      const r = await exec('git', ['rebase', integrationBranch], { cwd: worktreePath })
      output += r.stdout + r.stderr
    } catch (rebaseError: unknown) {
      const e = rebaseError as { stdout?: string; stderr?: string }
      output += (e.stdout ?? '') + (e.stderr ?? '')

      const supervisorTimeoutMs = 30 * 60 * 1000
      const sup = await invokeVcsSupervisor(
        branch,
        integrationBranch,
        worktreePath,
        supervisorTimeoutMs,
        onSupervisorEvent,
      )
      supervisorConversation.push(...sup.conversation)
      output += sup.stdout + sup.stderr

      const stillInProgress = await isRebaseInProgress(worktreePath)
      if (stillInProgress || sup.exitCode !== 0) {
        await exec('git', ['rebase', '--abort'], { cwd: worktreePath }).catch(() => {})
        return {
          merged: false,
          conflictResolved: false,
          aborted: true,
          output: `vcs-supervisor failed (exit ${sup.exitCode}); rebase aborted.\n${output}`,
          supervisorConversation,
        }
      }
      conflictResolved = true
    }

    // Step 2: fast-forward integration to the (now-rebased) task branch.
    await exec('git', ['checkout', integrationBranch], { cwd: repoRoot() })
    try {
      const r = await exec(
        'git',
        ['merge', '--ff-only', branch],
        { cwd: repoRoot() },
      )
      output += r.stdout + r.stderr
      return {
        merged: true,
        conflictResolved,
        aborted: false,
        output,
        supervisorConversation,
      }
    } catch (ffError: unknown) {
      const e = ffError as { stdout?: string; stderr?: string; message?: string }
      output += (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '')
      return {
        merged: false,
        conflictResolved,
        aborted: true,
        output: `fast-forward into ${integrationBranch} failed unexpectedly after rebase.\n${output}`,
        supervisorConversation,
      }
    }
  } finally {
    await release()
  }
}

export const isBranchMergedIntoMain = async (
  branch: string,
  repoRoot: string,
): Promise<boolean> => {
  try {
    await exec('git', ['merge-base', '--is-ancestor', branch, 'main'], {
      cwd: repoRoot,
    })
  } catch (err: unknown) {
    const code = (err as { code?: number }).code
    if (code === 1) return false
    return false
  }
  try {
    const { stdout } = await exec(
      'git',
      ['rev-list', '--count', `${branch}..main`],
      { cwd: repoRoot },
    )
    const mainAhead = Number.parseInt(stdout.trim(), 10)
    if (!Number.isFinite(mainAhead)) return false
    return mainAhead === 0
  } catch {
    return false
  }
}

export const isZeroCommitBranch = async (
  branch: string,
  repoRoot: string,
): Promise<boolean> => {
  try {
    const { stdout: tip } = await exec('git', ['rev-parse', branch], {
      cwd: repoRoot,
    })
    const { stdout: base } = await exec(
      'git',
      ['merge-base', branch, 'main'],
      { cwd: repoRoot },
    )
    return tip.trim() === base.trim()
  } catch {
    return false
  }
}
