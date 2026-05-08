/**
 * One-shot cleanup of the legacy `<repo>/.worktrees/` root.
 *
 * The orchestrator now uses `<repo>/.mars/worktrees/` exclusively. The old
 * `<repo>/.worktrees/` root predates that change and is no longer written to,
 * but its entries are still registered as git worktrees and clutter
 * `git worktree list`. This script removes every worktree under that legacy
 * root, deletes the directory, and prunes dangling administrative files.
 *
 * Branches (`task/<id>`) are intentionally retained.
 *
 * Run from the `orchestrator/` directory:
 *   npx tsx scripts/cleanup-legacy-worktrees.ts
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const exec = promisify(execFile)

/**
 * Resolve the main checkout's repo root, even when invoked from inside a
 * linked worktree. `--show-toplevel` returns the worktree path; the parent
 * of `--git-common-dir` is the shared `.git`'s repo, i.e. the main checkout.
 */
const findMainRepoRoot = async (cwd: string): Promise<string> => {
  const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd })
  return resolve(cwd, stdout.trim(), '..')
}

interface WorktreeEntry {
  path: string
  branch: string | null
}

const parsePorcelain = (output: string): WorktreeEntry[] => {
  const entries: WorktreeEntry[] = []
  let current: { path?: string; branch?: string | null } = {}
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('worktree ')) {
      if (current.path) {
        entries.push({ path: current.path, branch: current.branch ?? null })
      }
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('branch ')) {
      // Format: "branch refs/heads/<name>"
      const ref = line.slice('branch '.length)
      current.branch = ref.startsWith('refs/heads/')
        ? ref.slice('refs/heads/'.length)
        : ref
    } else if (line === 'detached') {
      current.branch = null
    } else if (line === '' && current.path) {
      entries.push({ path: current.path, branch: current.branch ?? null })
      current = {}
    }
  }
  if (current.path) {
    entries.push({ path: current.path, branch: current.branch ?? null })
  }
  return entries
}

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const main = async (): Promise<void> => {
  const repoRoot = await findMainRepoRoot(process.cwd())
  const legacyRoot = resolve(repoRoot, '.worktrees')
  const activeRoot = resolve(repoRoot, '.mars/worktrees')
  const legacyPrefix = `${legacyRoot}/`

  const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
  })
  const allEntries = parsePorcelain(stdout)
  const activeBefore = allEntries.filter((e) =>
    e.path.startsWith(`${activeRoot}/`),
  ).length
  const legacy = allEntries.filter((e) => e.path.startsWith(legacyPrefix))

  console.log(
    `Found ${legacy.length} legacy worktree entr${legacy.length === 1 ? 'y' : 'ies'} under ${legacyRoot}`,
  )

  const errors: { path: string; error: string }[] = []
  let removed = 0

  for (const entry of legacy) {
    console.log(`  removing ${entry.path}${entry.branch ? ` [${entry.branch}]` : ''}`)
    try {
      await exec('git', ['worktree', 'remove', '--force', entry.path], {
        cwd: repoRoot,
      })
      removed++
      continue
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`    git worktree remove failed: ${message.split('\n')[0]}`)
    }

    // Fallback: nuke the directory and rely on the final prune to clean up
    // the administrative entry under .git/worktrees/.
    try {
      if (await pathExists(entry.path)) {
        await rm(entry.path, { recursive: true, force: true })
      }
      removed++
    } catch (rmError: unknown) {
      const message =
        rmError instanceof Error ? rmError.message : String(rmError)
      errors.push({ path: entry.path, error: message })
    }
  }

  // Delete the now-empty legacy root if it still exists.
  if (await pathExists(legacyRoot)) {
    await rm(legacyRoot, { recursive: true, force: true }).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        errors.push({ path: legacyRoot, error: message })
      },
    )
  }

  // Final prune to clean dangling administrative entries.
  try {
    await exec('git', ['worktree', 'prune'], { cwd: repoRoot })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`git worktree prune warned: ${message.split('\n')[0]}`)
  }

  // Sanity check: active root unchanged.
  const { stdout: afterStdout } = await exec(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd: repoRoot },
  )
  const afterEntries = parsePorcelain(afterStdout)
  const activeAfter = afterEntries.filter((e) =>
    e.path.startsWith(`${activeRoot}/`),
  ).length

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`)
    for (const e of errors) console.error(`  - ${e.path}: ${e.error}`)
  }

  console.log(
    `removed ${removed} legacy worktrees; .worktrees/ directory ${
      (await pathExists(legacyRoot)) ? 'STILL PRESENT' : 'deleted'
    }; .mars/worktrees/ untouched (${activeAfter} entries remain, was ${activeBefore})`,
  )

  if (errors.length > 0) process.exit(1)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(message)
  process.exit(1)
})
