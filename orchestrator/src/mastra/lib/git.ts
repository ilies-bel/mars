import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { open, mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { getRepoRoot, getStateDir } from '../context'

const exec = promisify(execFile)

const repoRoot = (): string => getRepoRoot()
const moduleDir = (): string => dirname(fileURLToPath(import.meta.url))

export interface CreateWorktreeArgs {
  taskId: string
  integrationBranch: string
}

export interface WorktreeRef {
  path: string
  branch: string
}

export const createWorktree = async ({
  taskId,
  integrationBranch,
}: CreateWorktreeArgs): Promise<WorktreeRef> => {
  const branch = `task/${taskId}`
  const path = resolve(getStateDir(), `worktrees/${taskId}`)
  await exec('git', ['worktree', 'add', '-b', branch, path, integrationBranch], {
    cwd: repoRoot(),
  })
  return { path, branch }
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

export const runSubprocess = (
  cmd: string,
  args: readonly string[],
  cwd: string,
): Promise<RunSubprocessResult> =>
  new Promise((resolveFn) => {
    const child = spawn(cmd, args, { cwd, env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('close', (code) => {
      resolveFn({ exitCode: code ?? 1, stdout, stderr })
    })
  })

export interface RunClaudeArgs {
  cwd: string
  prompt: string
  timeoutMs: number
}

export interface RunClaudeResult extends RunSubprocessResult {
  sessionId: string | null
}

const extractSessionId = (stdout: string): string | null => {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as { session_id?: unknown }
    if (typeof parsed.session_id === 'string') return parsed.session_id
  } catch {
    // Fall through to regex scan in case stdout isn't a single JSON document.
  }
  const match = trimmed.match(/"session_id"\s*:\s*"([^"]+)"/)
  return match?.[1] ?? null
}

export const runClaudeCode = async ({
  cwd,
  prompt,
  timeoutMs,
}: RunClaudeArgs): Promise<RunClaudeResult> => {
  const work = runSubprocess(
    'claude',
    ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'],
    cwd,
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
  return { ...result, sessionId: extractSessionId(result.stdout) }
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

const acquireLock = async (
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
        await exec('rm', ['-f', lockPath]).catch(() => {})
      }
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error(`Failed to acquire merge lock after ${timeoutMs}ms`)
}

export interface MergeArgs {
  branch: string
  integrationBranch: string
  lockTimeoutMs: number
}

export interface MergeResult {
  merged: boolean
  conflictResolved: boolean
  aborted: boolean
  output: string
}

let cachedSupervisorSpec: string | null = null

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
  const spec = await loadSupervisorSpec()
  return `${spec}

---

# This dispatch

Mode: merge
Source: ${branch}
Target: ${integrationBranch}

A \`git merge --no-ff ${branch}\` into ${integrationBranch} has just conflicted in this repo. The merge is in progress (\`.git/MERGE_HEAD\` exists). Resolve every conflict per your protocol — read both sides, reconcile intent, never blindly pick ours/theirs — then run verification, and commit.

Verification commands for this repo:
- typecheck: \`npx tsc --noEmit\`
- tests:     \`npm test --silent\`
- lint:      \`npx biome check .\`

End with the Completion Report block exactly as specified above.`
}

const invokeVcsSupervisor = async (
  branch: string,
  integrationBranch: string,
  timeoutMs: number,
): Promise<RunSubprocessResult> => {
  const prompt = await buildSupervisorPrompt(branch, integrationBranch)
  const work = runSubprocess(
    'claude',
    ['-p', prompt, '--dangerously-skip-permissions'],
    repoRoot(),
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
  return Promise.race([work, timeout])
}

const isMergeInProgress = async (): Promise<boolean> => {
  try {
    await exec('test', ['-f', resolve(repoRoot(), '.git/MERGE_HEAD')])
    return true
  } catch {
    return false
  }
}

export const mergeBranch = async ({
  branch,
  integrationBranch,
  lockTimeoutMs,
}: MergeArgs): Promise<MergeResult> => {
  const release = await acquireLock(
    resolve(getStateDir(), '.merge.lock'),
    lockTimeoutMs,
  )
  try {
    let output = ''
    await exec('git', ['checkout', integrationBranch], { cwd: repoRoot() })
    const ahead = await exec(
      'git',
      ['rev-list', '--count', `${integrationBranch}..${branch}`],
      { cwd: repoRoot() },
    )
    if (ahead.stdout.trim() === '0') {
      return {
        merged: false,
        conflictResolved: false,
        aborted: true,
        output: `task branch ${branch} has 0 commits ahead of ${integrationBranch}; nothing to merge`,
      }
    }
    try {
      const r = await exec(
        'git',
        ['merge', '--no-ff', '-m', `merge ${branch}`, branch],
        { cwd: repoRoot() },
      )
      output = r.stdout + r.stderr
      return { merged: true, conflictResolved: false, aborted: false, output }
    } catch (mergeError: unknown) {
      const supervisorTimeoutMs = 30 * 60 * 1000
      const sup = await invokeVcsSupervisor(branch, integrationBranch, supervisorTimeoutMs)
      output = sup.stdout + sup.stderr

      const stillInProgress = await isMergeInProgress()
      if (stillInProgress || sup.exitCode !== 0) {
        await exec('git', ['merge', '--abort'], { cwd: repoRoot() }).catch(() => {})
        return {
          merged: false,
          conflictResolved: false,
          aborted: true,
          output: `vcs-supervisor failed (exit ${sup.exitCode}); merge aborted.\n${output}`,
        }
      }

      return { merged: true, conflictResolved: true, aborted: false, output }
    }
  } finally {
    await release()
  }
}
