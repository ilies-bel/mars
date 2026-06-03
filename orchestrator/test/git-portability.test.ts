/**
 * Cross-OS portability tests for the orchestrator git helper.
 *
 * These tests pin two invariants we want to survive any future refactor:
 *
 *  1. The path-existence check `pathExists(p)` is implemented at the
 *     filesystem level (not as a shell-out to `test -e`), so it returns
 *     the same answer on darwin, linux, and windows.
 *
 *  2. The module never reintroduces POSIX-only shell invocations
 *     (`/bin/test`, `/usr/bin/test`, `sh -c`, `bash -c`). `git` itself
 *     is portable and is invoked through `execFile` (no shell), so any
 *     such call would have to be a new regression — this assertion
 *     surfaces it immediately.
 *
 * The audit assertion encodes the "audit" acceptance criterion from
 * slice 2 of the multi-OS binaries PRD as a runnable check, so a future
 * change can't silently undo the portability work.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathExists } from '../src/core/lib/git/internal'

const here = dirname(fileURLToPath(import.meta.url))
// The git helper was split from a single `git.ts` into the `git/` directory
// (internal/worktree/claude/verify/merge/lock). Scan every module in it so
// the POSIX-shell-out audit can't be evaded by a regression in any one file.
const gitModuleDir = resolve(here, '..', 'src', 'core', 'lib', 'git')

async function readGitModuleSource(): Promise<string> {
  const names = (await readdir(gitModuleDir))
    .filter((name) => extname(name) === '.ts' && !name.endsWith('.test.ts'))
    .sort()
  const parts = await Promise.all(
    names.map((name) => readFile(join(gitModuleDir, name), 'utf8')),
  )
  return parts.join('\n')
}

describe('git helper — cross-OS path existence', () => {
  let scratch: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'mars-git-portability-'))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('reports an existing regular file as present', async () => {
    const file = join(scratch, 'regular.txt')
    await writeFile(file, 'present', 'utf8')
    await expect(pathExists(file)).resolves.toBe(true)
  })

  it('reports an existing directory as present', async () => {
    const dir = join(scratch, 'a-directory')
    await mkdir(dir)
    await expect(pathExists(dir)).resolves.toBe(true)
  })

  it('reports a symlink to an existing target as present', async () => {
    const target = join(scratch, 'symlink-target.txt')
    const link = join(scratch, 'symlink')
    await writeFile(target, 'target', 'utf8')
    try {
      await symlink(target, link)
    } catch (err: unknown) {
      // On Windows without dev-mode or admin, symlink() is denied. The
      // POSIX-portability claim does not depend on symlink creation
      // succeeding on the host running the test — skip rather than fail.
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'ENOSYS') return
      throw err
    }
    await expect(pathExists(link)).resolves.toBe(true)
  })

  it('reports a missing path as absent', async () => {
    const ghost = join(scratch, 'never-created')
    await expect(pathExists(ghost)).resolves.toBe(false)
  })

  it('treats an empty string as absent rather than as cwd', async () => {
    // `test -e ""` returns false on POSIX shells, and the JS replacement
    // matches that contract. The empty-string guard also protects against
    // accidental callers that build paths via string concat and end up
    // with "".
    await expect(pathExists('')).resolves.toBe(false)
  })
})

describe('git helper — no POSIX-only shell-outs', () => {
  it('does not invoke /bin/test, /usr/bin/test, sh -c, or bash -c anywhere in the module', async () => {
    const source = await readGitModuleSource()

    // Strip line and block comments so prose like the doc comment
    // explaining why `test -e` was retired does not produce a false
    // positive. String literals are KEPT intentionally: the original
    // POSIX shell-out had the binary name as a string argument
    // (`exec('test', ['-e', p])`), so an audit that erased string
    // contents would miss the exact regression it is meant to catch.
    const stripped = stripComments(source)

    const forbiddenPatterns: Array<{ label: string; re: RegExp }> = [
      { label: '/bin/test', re: /\/bin\/test\b/ },
      { label: '/usr/bin/test', re: /\/usr\/bin\/test\b/ },
      // exec('test', ...) or execFile('test', ...) — the original
      // POSIX-only shell-out the slice replaced.
      { label: "exec('test', ...)", re: /\bexec(File)?\s*\(\s*['"`]test['"`]\s*,/ },
      // Shell pipelines: `sh -c "..."` / `bash -c "..."`
      { label: 'sh -c', re: /\bexec(File)?\s*\(\s*['"`](\/bin\/)?sh['"`]\s*,/ },
      {
        label: 'bash -c',
        re: /\bexec(File)?\s*\(\s*['"`](\/bin\/)?bash['"`]\s*,/,
      },
      // `spawn('sh' | 'bash', ...)` — same problem via a different API.
      {
        label: 'spawn(sh|bash)',
        re: /\bspawn\s*\(\s*['"`](\/bin\/)?(sh|bash)['"`]\s*,/,
      },
    ]

    const hits = forbiddenPatterns.filter(({ re }) => re.test(stripped))
    expect(
      hits.map((h) => h.label),
      `git.ts should not contain POSIX-only shell invocations; found: ${hits
        .map((h) => h.label)
        .join(', ')}`,
    ).toEqual([])
  })

  it('would catch a reintroduced exec(test, [-e, p]) call', () => {
    // Self-test for the audit: the regression we are pinning is the
    // original POSIX shell-out. If someone re-adds it, the audit MUST
    // fire. We synthesise a minimal source snippet containing that call
    // and run it through the same stripper + regex set the audit uses.
    const regressed = "const r = await exec('test', ['-e', p])\n"
    const stripped = stripComments(regressed)
    const re = /\bexec(File)?\s*\(\s*['"`]test['"`]\s*,/
    expect(re.test(stripped)).toBe(true)
  })
})

/**
 * Remove `//` line comments and `/* … * /` block comments from a
 * TypeScript source file. String literal contents are deliberately
 * preserved — they are the audit target.
 *
 * The walker also skips over string literals without inspecting them
 * for comment markers, so a `//` inside a `"…"` string is not mistaken
 * for the start of a comment.
 */
const stripComments = (src: string): string => {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    const next = src[i + 1]
    // line comment
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i + 2)
      if (nl === -1) break
      out += '\n'
      i = nl + 1
      continue
    }
    // block comment
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) break
      out += ' '
      i = end + 2
      continue
    }
    // string literal — copy verbatim, but do not look inside for comments
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += quote
      i += 1
      while (i < n) {
        const c = src[i]
        if (c === '\\') {
          out += src.slice(i, i + 2)
          i += 2
          continue
        }
        out += c
        i += 1
        if (c === quote) break
      }
      continue
    }
    out += ch
    i += 1
  }
  return out
}
