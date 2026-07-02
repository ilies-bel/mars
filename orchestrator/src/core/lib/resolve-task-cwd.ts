import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readSupervisorsManifest, resolveVerifyCwd } from './derive-repro-command'

/**
 * Resolve the project subdirectory the implementor agent should treat as
 * "where verify, typecheck, and build commands run". This is the cwd
 * disclosed in the prompt — not the worker process's spawn cwd, which
 * stays at the worktree root so Mars CLI commands resolve `repoRoot()`
 * correctly and slices that span multiple subprojects still work.
 *
 * Resolution order:
 *
 * 1. If `files` is empty there is no signal to lean on; fall back to
 *    {@link resolveVerifyCwd}, which is the same heuristic verify uses.
 * 2. Otherwise compute the longest *path-segment-wise* common prefix of
 *    the file paths. `'.github/'` and `'.gitignore'` share no segment
 *    (segment-wise, not character-wise).
 * 3. Walk that prefix upward — from the most-specific directory down to
 *    (but not including) the worktree root — and return the first
 *    directory under `worktreeRoot` that contains both `package.json`
 *    AND `tsconfig.json` (TS-specific heuristic).
 * 4. Config override from the supervisors manifest: find the supervisor
 *    whose `scope` is the longest prefix of (or exact match for) the
 *    common file path prefix. Uses `verifyCwd` if declared, otherwise
 *    `scope`. Covers non-JS monorepos (Kotlin, Python, Rust, …) where
 *    the TS heuristic never fires. When no supervisor scope matches the
 *    file prefix, this step is skipped.
 * 5. Fall back to {@link resolveVerifyCwd} (handles the single-supervisor
 *    non-JS case and the root-project case).
 */
export const resolveTaskCwd = (
  worktreeRoot: string,
  files: readonly string[],
): string => {
  if (files.length === 0) return resolveVerifyCwd(worktreeRoot)

  const commonSegments = longestCommonPathPrefix(files)
  if (commonSegments.length === 0) return resolveVerifyCwd(worktreeRoot)

  const hasProject = (dir: string): boolean =>
    existsSync(resolve(dir, 'package.json')) &&
    existsSync(resolve(dir, 'tsconfig.json'))

  // Walk the common-prefix path upward. The deepest segment may be a
  // filename (e.g. `orchestrator/src/foo.ts`); we still try it as a
  // candidate path so callers that pass directory-only paths get the
  // intuitive answer.
  const segments = [...commonSegments]
  while (segments.length > 0) {
    const candidate = resolve(worktreeRoot, ...segments)
    if (hasProject(candidate)) return candidate
    segments.pop()
  }

  // TS heuristic found no project. Try matching the common file prefix
  // against supervisor scopes in the manifest. Pick the most specific
  // (longest) scope that is a prefix of the common segments.
  const entries = readSupervisorsManifest(worktreeRoot)
  let best: { scopeLength: number; verifyCwd: string } | null = null
  for (const entry of entries) {
    const scopeSegs = entry.scope
      .split('/')
      .filter((s) => s.length > 0 && s !== '.')
    if (scopeSegs.length === 0) continue
    if (scopeSegs.length > commonSegments.length) continue
    const isPrefix = scopeSegs.every((seg, i) => commonSegments[i] === seg)
    if (!isPrefix) continue
    const verifyCwd = entry.verifyCwd ?? entry.scope
    if (verifyCwd === '.' || verifyCwd === '') continue
    if (best === null || scopeSegs.length > best.scopeLength) {
      best = { scopeLength: scopeSegs.length, verifyCwd }
    }
  }
  if (best !== null) return resolve(worktreeRoot, best.verifyCwd)

  // When the manifest had non-root entries but none matched the file
  // prefix, we cannot safely guess which supervisor's verifyCwd applies.
  // Return the worktree root rather than letting resolveVerifyCwd's
  // single-supervisor heuristic pick an unrelated scope.
  const hasNonRootEntries = entries.some((e) => {
    const v = e.verifyCwd ?? e.scope
    return v !== '.' && v !== ''
  })
  if (hasNonRootEntries) return worktreeRoot

  return resolveVerifyCwd(worktreeRoot)
}

/**
 * Longest path-segment-wise common prefix across a list of POSIX-ish
 * relative paths. Splitting on `/` and dropping empty segments means
 * `'.github/'` and `'.gitignore'` correctly share zero segments rather
 * than the character-level `'.git'`.
 */
const longestCommonPathPrefix = (files: readonly string[]): string[] => {
  const lists = files.map((f) =>
    f.split('/').filter((s) => s.length > 0),
  )
  if (lists.length === 0) return []
  const first = lists[0]
  const common: string[] = []
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]
    if (lists.every((list) => list[i] === seg)) {
      common.push(seg)
    } else {
      break
    }
  }
  return common
}
