/**
 * Worktree integrity check — determines whether an existing linked worktree
 * directory is structurally sound enough for the setup step to reuse rather
 * than re-create.
 *
 * Returns a discriminated result so the caller can log a precise reason and
 * choose its recovery path without parsing error messages.
 */
import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type IntegrityOk = { ok: true }
export type IntegrityFail = {
  ok: false
  reason: 'missing-dir' | 'not-a-worktree' | 'wrong-branch' | 'missing-node-modules'
}
export type IntegrityResult = IntegrityOk | IntegrityFail

/**
 * Check whether a worktree directory is structurally intact and on the
 * expected branch.
 *
 * Checks performed in order:
 * 1. Directory exists on disk.
 * 2. `git -C <root> rev-parse --is-inside-work-tree` exits 0 (confirms it is
 *    a real git working tree, linked or main).
 * 3. `git -C <root> rev-parse --abbrev-ref HEAD` returns the expected branch
 *    name.
 * 4. If a `package.json` exists at the root, `node_modules` must also exist
 *    (a missing modules dir means an install is required before any code can
 *    run).
 *
 * All git invocations use `git -C <root>` rather than `cd`, per repo
 * conventions.
 */
export async function checkWorktreeIntegrity(
  worktreeRoot: string,
  expectedBranch: string,
): Promise<IntegrityResult> {
  // 1. Directory exists?
  try {
    await stat(worktreeRoot)
  } catch {
    return { ok: false, reason: 'missing-dir' }
  }

  // 2. Is it a git working tree?
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      worktreeRoot,
      'rev-parse',
      '--is-inside-work-tree',
    ])
    if (stdout.trim() !== 'true') {
      return { ok: false, reason: 'not-a-worktree' }
    }
  } catch {
    return { ok: false, reason: 'not-a-worktree' }
  }

  // 3. HEAD on the expected branch?
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      worktreeRoot,
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ])
    const currentBranch = stdout.trim()
    if (currentBranch !== expectedBranch) {
      return { ok: false, reason: 'wrong-branch' }
    }
  } catch {
    return { ok: false, reason: 'wrong-branch' }
  }

  // 4. If package.json exists, node_modules must too.
  const packageJsonPath = join(worktreeRoot, 'package.json')
  const nodeModulesPath = join(worktreeRoot, 'node_modules')
  try {
    await access(packageJsonPath)
    // package.json exists — check node_modules
    try {
      await stat(nodeModulesPath)
    } catch {
      return { ok: false, reason: 'missing-node-modules' }
    }
  } catch {
    // No package.json — node_modules check does not apply.
  }

  return { ok: true }
}
