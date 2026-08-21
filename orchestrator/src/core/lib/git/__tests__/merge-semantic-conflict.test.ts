/**
 * ADR-0100 semantic-conflict integration test.
 *
 * The classic composition hazard: branch A renames an exported symbol and
 * updates every call site it knows about; branch B, cut from the same base
 * *before* A's rename, adds a brand-new caller of the old name. Neither
 * branch touches a line the other touches, so `git rebase` never sees a
 * textual conflict — the breakage is purely semantic (a call to a symbol
 * that no longer exists) and only a real verify run on the *composed* tree
 * can catch it.
 *
 * Under the pre-ADR-0100 "verify against your own base, fast-forward
 * unconditionally" ordering, both branches look green individually and the
 * second merge would land a broken `main`. Under rebase→verify→ff
 * (`onVerifyRebasedTree`), the second merge's gate runs on the REBASED tree
 * — after A's rename has already replayed underneath B — so it sees the
 * dangling call and rejects before anything fast-forwards.
 *
 * The stand-in "typecheck" (`verify.sh`) is a trivial grep: it fails a tree
 * iff some `*.js` file calls `oldName(` while `src/lib.js` no longer defines
 * `function oldName`. That is exactly what a real typechecker would flag,
 * without pulling in an actual TS toolchain for the fixture repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import { mergeBranch, type MergeGateOutcome } from '../merge'
import { __resetContextCacheForTests } from '../../../context'

let repoDir: string
let worktreeRename: string
let worktreeAddCaller: string
let prevMarsRepo: string | undefined

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const writeFileDeep = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

const commitFile = (name: string, contents: string, message: string): void => {
  writeFileDeep(resolve(repoDir, name), contents)
  git('add', name)
  git('commit', '-m', message)
}

const VERIFY_SCRIPT = `#!/bin/sh
# Stand-in for a typecheck: fails iff some *.js file calls oldName(...)
# while src/lib.js no longer defines it.
set -e
CALLERS=$(grep -rl 'oldName(' --include='*.js' . 2>/dev/null || true)
if [ -n "$CALLERS" ]; then
  if ! grep -q 'function oldName' src/lib.js 2>/dev/null; then
    echo "verify: oldName() is called but src/lib.js no longer defines it" >&2
    echo "callers:" >&2
    echo "$CALLERS" >&2
    exit 1
  fi
fi
exit 0
`

/** Runs the fixture's stand-in verify script against `cwd`, as a MergeGateOutcome. */
const runVerify = (cwd: string): MergeGateOutcome => {
  try {
    execFileSync('sh', ['verify.sh'], { cwd, encoding: 'utf8' })
    return { passed: true }
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string }
    return { passed: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

beforeAll(() => {
  repoDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-semantic-conflict-'))
  worktreeRename = `${repoDir}-wt-rename`
  worktreeAddCaller = `${repoDir}-wt-add-caller`
  prevMarsRepo = process.env.MARS_REPO
  process.env.MARS_REPO = repoDir
  __resetContextCacheForTests()

  git('init', '-b', 'main')
  git('config', 'user.email', 'test@mars.local')
  git('config', 'user.name', 'Mars Test')
  git('config', 'commit.gpgsign', 'false')

  // `getStateDir()` materialises `.mars/` inside the repo. Ignore it so it
  // never trips a dirty-worktree/dirty-main check.
  commitFile('.gitignore', '.mars/\n', 'c0: ignore orchestrator state')

  commitFile(
    'src/lib.js',
    "function oldName() { return 1 }\nmodule.exports = { oldName }\n",
    'c1: define oldName',
  )
  commitFile(
    'src/main.js',
    "const { oldName } = require('./lib')\nconsole.log(oldName())\n",
    'c1: call oldName from main',
  )
  writeFileSync(resolve(repoDir, 'verify.sh'), VERIFY_SCRIPT)
  chmodSync(resolve(repoDir, 'verify.sh'), 0o755)
  git('add', 'verify.sh')
  git('commit', '-m', 'c1: add verify script')

  // Branch A ("rename"): renames the exported symbol and updates every call
  // site it knows about.
  git('branch', 'task/rename')
  git('worktree', 'add', '--quiet', worktreeRename, 'task/rename')
  writeFileDeep(
    resolve(worktreeRename, 'src/lib.js'),
    "function newName() { return 1 }\nmodule.exports = { newName }\n",
  )
  writeFileDeep(
    resolve(worktreeRename, 'src/main.js'),
    "const { newName } = require('./lib')\nconsole.log(newName())\n",
  )
  gitIn(worktreeRename, 'add', 'src/lib.js', 'src/main.js')
  gitIn(worktreeRename, 'commit', '-m', 'rename oldName to newName')

  // Branch B ("add-caller"): cut from the SAME base commit, before A's
  // rename. Adds a brand-new caller of the (still-current, from B's view)
  // old name. Does not touch lib.js or main.js, so rebasing onto A's tip
  // later produces zero textual conflicts.
  git('branch', 'task/add-caller')
  git('worktree', 'add', '--quiet', worktreeAddCaller, 'task/add-caller')
  writeFileDeep(
    resolve(worktreeAddCaller, 'src/extra.js'),
    "const { oldName } = require('./lib')\nconsole.log('extra', oldName())\n",
  )
  gitIn(worktreeAddCaller, 'add', 'src/extra.js')
  gitIn(worktreeAddCaller, 'commit', '-m', 'add extra caller of oldName')
})

afterAll(() => {
  if (prevMarsRepo !== undefined) {
    process.env.MARS_REPO = prevMarsRepo
  } else {
    delete process.env.MARS_REPO
  }
  __resetContextCacheForTests()
  rmSync(worktreeRename, { recursive: true, force: true })
  rmSync(worktreeAddCaller, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

describe('mergeBranch — semantic conflict (rename + new caller)', () => {
  it('both branches verify cleanly against their own base', () => {
    // A's own tree: the rename touched every call site it knows about, so
    // no *.js file calls the old name any more.
    expect(() => runVerify(worktreeRename)).not.toThrow()
    expect(runVerify(worktreeRename).passed).toBe(true)

    // B's own tree: unaware of A, oldName is still defined in lib.js and
    // every caller (including the new one) agrees with that.
    expect(runVerify(worktreeAddCaller).passed).toBe(true)
  })

  it(
    'lands A, then rejects B post-rebase without ever advancing main past a failed verify',
    async () => {
      // --- Merge A: rename lands cleanly. ---
      const resultA = await mergeBranch({
        branch: 'task/rename',
        worktreePath: worktreeRename,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        onVerifyRebasedTree: async (): Promise<MergeGateOutcome> =>
          runVerify(worktreeRename),
      })

      expect(resultA.merged).toBe(true)
      expect(resultA.reason).toBeUndefined()

      const shaAfterA = git('rev-parse', 'main')
      expect(shaAfterA).toBe(gitIn(worktreeRename, 'rev-parse', 'HEAD'))

      // main really did pick up the rename: no more `function oldName`.
      expect(git('show', 'main:src/lib.js')).toContain('function newName')
      expect(git('show', 'main:src/lib.js')).not.toContain('oldName')

      // --- Merge B: rebases onto A's tip with zero textual conflict, but
      // the composed tree is semantically broken (extra.js still calls the
      // now-undefined oldName). The rebased-tree verify must catch it. ---
      const resultB = await mergeBranch({
        branch: 'task/add-caller',
        worktreePath: worktreeAddCaller,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        onVerifyRebasedTree: async (): Promise<MergeGateOutcome> =>
          runVerify(worktreeAddCaller),
      })

      expect(resultB.merged).toBe(false)
      expect(resultB.aborted).toBe(false)
      expect(resultB.reason).toBe('rebased-verify-failed')
      expect(resultB.rebasedVerifyOutput).toContain(
        'oldName() is called but src/lib.js no longer defines it',
      )

      // The rebase itself was conflict-free (that's the whole point of a
      // *semantic* conflict) — confirm no rebase-in-progress state was left
      // behind and B's worktree cleanly rebased onto A's tip.
      expect(gitIn(worktreeAddCaller, 'status', '--porcelain')).toBe('')

      // main never moved past A: the rejected composition never landed.
      expect(git('rev-parse', 'main')).toBe(shaAfterA)

      // Explicit negative: main's actual tree (this checkout IS main, since
      // Step 3 resyncs it on every successful fast-forward) still passes
      // verify — it was never advanced to a tree that failed it.
      expect(runVerify(repoDir).passed).toBe(true)
      expect(git('show', 'main:src/lib.js')).not.toContain('function oldName')
    },
    30_000,
  )
})
