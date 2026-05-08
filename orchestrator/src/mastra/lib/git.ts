import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { open, mkdir, readFile, unlink } from 'node:fs/promises'
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
  await exec('git', ['worktree', 'add', '-b', branch, path, startPoint], {
    cwd: repoRoot(),
  })
  return { path, branch }
}

export const resolveSha = async (ref: string): Promise<string> => {
  const { stdout } = await exec('git', ['rev-parse', ref], { cwd: repoRoot() })
  return stdout.trim()
}

export const removeWorktree = async (
  ref: WorktreeRef,
  force = true,
): Promise<void> => {
  const args = ['worktree', 'remove']
  if (force) args.push('--force')
  args.push(ref.path)
  await exec('git', args, { cwd: repoRoot() })
  await exec('git', ['branch', '-D', ref.branch], { cwd: repoRoot() }).catch(() => {})
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

    child.stdout.on('data', (chunk) => handleChunk('stdout', chunk))
    child.stderr.on('data', (chunk) => handleChunk('stderr', chunk))
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
      resolveFn({ exitCode: code ?? 1, stdout, stderr })
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

const claudeStreamArgs = (
  prompt: string,
  options: ClaudeStreamArgsOptions = {},
): readonly string[] => [
  '-p',
  prompt,
  '--output-format',
  'stream-json',
  '--verbose',
  '--dangerously-skip-permissions',
  ...(options.model ? ['--model', options.model] : []),
  ...(options.systemPrompt ? ['--system-prompt', options.systemPrompt] : []),
  ...(options.sessionId ? ['--session-id', options.sessionId] : []),
]

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
  const work = runSubprocessStreaming(
    'claude',
    claudeStreamArgs(prompt, { model, systemPrompt, sessionId }),
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
  return { ...result, sessionId: detectedSessionId, conversation }
}

export interface VerifyStep {
  name: string
  passed: boolean
  output: string
}

export interface VerifyArgs {
  cwd: string
  typecheckCmd: readonly [string, readonly string[]]
  testCmd: readonly [string, readonly string[]]
  lintCmd: readonly [string, readonly string[]]
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

export const verifyChanges = async (
  args: VerifyArgs,
): Promise<{ passed: boolean; steps: VerifyStep[] }> => {
  const steps: VerifyStep[] = []
  steps.push(await runVerifyStep('typecheck', args.typecheckCmd[0], args.typecheckCmd[1], args.cwd))
  if (steps[0].passed) {
    steps.push(await runVerifyStep('test', args.testCmd[0], args.testCmd[1], args.cwd))
  }
  if (steps[1]?.passed) {
    steps.push(await runVerifyStep('lint', args.lintCmd[0], args.lintCmd[1], args.cwd))
  }
  return { passed: steps.every((s) => s.passed), steps }
}

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
  const promptPath = resolve(moduleDir(), '../../prompts/vcs-supervisor.md')
  cachedSupervisorSpec = await readFile(promptPath, 'utf8')
  return cachedSupervisorSpec
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
    'claude',
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
