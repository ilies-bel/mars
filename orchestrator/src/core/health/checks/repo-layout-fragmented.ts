/**
 * Health check: worktree node_modules virtual store stays inside the checkout.
 *
 * Registers `repo.layout.fragmented` in the singleton CheckDef registry so
 * `mars doctor` can enumerate it and the Steward can run it on a schedule.
 *
 * Detection signals
 * -----------------
 * For each active worktree under `.mars/worktrees/`, the check reads
 * `<worktree>/node_modules/.modules.yaml` and inspects the `virtualStoreDir`
 * field that pnpm writes there.  When that path resolves *outside* the
 * worktree boundary it means the virtual store escaped into the main
 * checkout's `node_modules/` directory — the fragmented condition this check
 * is designed to surface.
 *
 * Returns findingKey='repo.layout.fragmented' as soon as any one worktree is
 * found to be fragmented.  The first such path is included in `detail` to
 * make the finding actionable without extra queries.
 *
 * Conservative behaviour
 * ----------------------
 * - When the worktrees directory does not exist (daemon never ran, fresh repo)
 *   the check returns ok=true.
 * - When `.modules.yaml` is missing for a worktree the install has not yet
 *   materialised node_modules there; the worktree is skipped.
 * - Unexpected filesystem errors are caught; their worktree is skipped rather
 *   than causing a false-positive finding.
 *
 * Runtime wiring
 * --------------
 * The daemon calls {@link wireRepoLayoutFragmentedCheck} at boot.  Until
 * wired, `run()` conservatively returns ok=true.
 *
 * Prereqs:
 *   'git' — worktrees are git concepts; git must be usable.
 *   'fs'  — needs filesystem access to read .modules.yaml files.
 */

import { resolve, join } from 'node:path'
import { registerCheck } from '../registry.js'

// ── Dep injection ──────────────────────────────────────────────────────────────

/** Injectable filesystem deps for the fragmented-layout detector. */
export interface RepoLayoutFragmentedDeps {
  /** Absolute path to the repo root. */
  repoRoot: string
  /**
   * Read the UTF-8 content of `path`.
   * Returns null when the file is absent or unreadable (no throws expected).
   */
  readFile(path: string): Promise<string | null>
  /**
   * List the names of immediate children of `dir`.
   * Returns an empty array when the directory is absent or unreadable.
   */
  readDir(dir: string): Promise<string[]>
}

let _deps: RepoLayoutFragmentedDeps | null = null

/**
 * Wire the check with runtime filesystem dependencies.
 *
 * Must be called by the daemon at boot before the first scheduled health pass.
 * Tests call this with injected stubs to drive `run()` without touching disk.
 */
export function wireRepoLayoutFragmentedCheck(deps: RepoLayoutFragmentedDeps): void {
  _deps = deps
}

// ── Core detector ─────────────────────────────────────────────────────────────

/**
 * Parse pnpm's `virtualStoreDir` from a `.modules.yaml` string.
 *
 * pnpm always writes the field on its own line, unquoted:
 *   virtualStoreDir: ../../../node_modules/.pnpm
 *
 * Returns null when the field is not present.
 */
function parseVirtualStoreDir(modulesYaml: string): string | null {
  const match = /^virtualStoreDir:\s*(.+)$/m.exec(modulesYaml)
  return match?.[1]?.trim() ?? null
}

/**
 * Check a single worktree for virtual-store fragmentation.
 *
 * @param worktreePath  Absolute path to the worktree root.
 * @param deps          Injected filesystem operations.
 * @returns `{ escaped: true, resolvedPath }` when the virtual store resolves
 *          outside the worktree boundary, `{ escaped: false }` otherwise.
 */
async function isWorktreeFragmented(
  worktreePath: string,
  deps: RepoLayoutFragmentedDeps,
): Promise<{ escaped: boolean; resolvedPath?: string }> {
  const modulesYamlPath = join(worktreePath, 'node_modules', '.modules.yaml')
  const content = await deps.readFile(modulesYamlPath)
  if (content === null) {
    // No .modules.yaml — install has not materialised here; skip conservatively.
    return { escaped: false }
  }

  const raw = parseVirtualStoreDir(content)
  if (!raw) return { escaped: false }

  // pnpm stores the path relative to the node_modules directory.
  const nmDir = join(worktreePath, 'node_modules')
  const resolved = resolve(nmDir, raw)

  // The virtual store is fragmented when it resolves outside the worktree.
  const boundary = worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`
  const escaped = resolved !== worktreePath && !resolved.startsWith(boundary)

  return escaped ? { escaped: true, resolvedPath: resolved } : { escaped: false }
}

// ── Registration ───────────────────────────────────────────────────────────────

registerCheck({
  id: 'repo.layout.fragmented',
  description:
    'Worktree installs: pnpm virtual store stays inside each worktree boundary',
  requires: ['git', 'fs'],
  route: 'fix',

  async run(_ctx) {
    if (_deps === null) {
      // Not yet wired — conservative pass to avoid false positives at boot.
      return { ok: true }
    }

    const worktreesDir = join(_deps.repoRoot, '.mars', 'worktrees')
    const entries = await _deps.readDir(worktreesDir)

    for (const entry of entries) {
      const worktreePath = join(worktreesDir, entry)
      try {
        const result = await isWorktreeFragmented(worktreePath, _deps)
        if (result.escaped) {
          return {
            ok: false,
            findingKey: 'repo.layout.fragmented',
            detail:
              `Worktree ${entry}: pnpm virtual store escaped to ${result.resolvedPath ?? '(unknown)'}` +
              ` — node_modules cost is inflated across all worktrees.`,
          }
        }
      } catch {
        // Unexpected filesystem error — skip this worktree conservatively.
        continue
      }
    }

    return { ok: true }
  },
})
