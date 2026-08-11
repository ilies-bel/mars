/**
 * Tests for the `repo.layout.fragmented` registered health check.
 *
 * Covers:
 *   - Registry presence (listChecks includes the check after index is imported).
 *   - Static metadata (id, description, requires, route).
 *   - Detection: fragmented fixture → ok=false+findingKey.
 *   - Detection: clean fixture (no escaped store) → ok=true.
 *   - Detection: no worktrees directory → ok=true (conservative).
 *   - Detection: .modules.yaml absent for a worktree → worktree skipped.
 *   - Idempotent fix-route enqueue via healthPass (repeated passes do not duplicate).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RepoLayoutFragmentedDeps } from '../checks/repo-layout-fragmented.js'

// ─── fixture helpers ──────────────────────────────────────────────────────────

/** Build a minimal .modules.yaml content with the given virtualStoreDir line. */
const modulesYaml = (virtualStoreDir: string): string =>
  `hoistingLimits: workspaces\nvirtualStoreDir: ${virtualStoreDir}\npackageManager: pnpm\n`

/**
 * Build stub deps for the repo-layout check.
 *
 * `files` — map of absolute path → file content (null = absent)
 * `dirs`  — map of absolute path → list of child names (absent = empty)
 */
const makeStubDeps = (
  repoRoot: string,
  files: Record<string, string | null>,
  dirs: Record<string, string[]>,
): RepoLayoutFragmentedDeps => ({
  repoRoot,
  readFile: async (path: string): Promise<string | null> => files[path] ?? null,
  readDir: async (dir: string): Promise<string[]> => dirs[dir] ?? [],
})

// ─── tests ────────────────────────────────────────────────────────────────────

describe('repo.layout.fragmented health check', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // ── Registry presence ──────────────────────────────────────────────────────

  it('appears in listChecks() after the index module is imported', async () => {
    await import('../index.js')
    const { listChecks } = await import('../registry.js')

    const ids = listChecks().map((c) => c.id)
    expect(ids).toContain('repo.layout.fragmented')
  })

  it('has the correct static metadata', async () => {
    await import('../checks/repo-layout-fragmented.js')
    const { listChecks } = await import('../registry.js')

    const check = listChecks().find((c) => c.id === 'repo.layout.fragmented')
    expect(check).toBeDefined()
    expect(check?.description).toBeTruthy()
    expect(check?.requires).toContain('git')
    expect(check?.requires).toContain('fs')
    expect(check?.route).toBe('fix')
  })

  // ── Conservative pass when not wired ──────────────────────────────────────

  it('reports ok=true (conservative) when not yet wired', async () => {
    await import('../checks/repo-layout-fragmented.js')
    const { listChecks } = await import('../registry.js')

    const check = listChecks().find((c) => c.id === 'repo.layout.fragmented')!
    const outcome = await check.run({ prereqs: new Set(['git', 'fs']) })

    expect(outcome.ok).toBe(true)
  })

  // ── Clean fixture: no fragmentation ───────────────────────────────────────

  it('reports ok=true when all worktrees have their virtual store inside their boundary', async () => {
    const { wireRepoLayoutFragmentedCheck } = await import('../checks/repo-layout-fragmented.js')
    const { listChecks } = await import('../registry.js')

    const repoRoot = '/repo'
    const worktreeId = 'mars-abc123'
    const worktreePath = `/repo/.mars/worktrees/${worktreeId}`
    // Virtual store inside the worktree boundary — healthy
    const inBoundaryVsd = `${worktreePath}/node_modules/.pnpm`

    wireRepoLayoutFragmentedCheck(
      makeStubDeps(
        repoRoot,
        { [`${worktreePath}/node_modules/.modules.yaml`]: modulesYaml(inBoundaryVsd) },
        { [`${repoRoot}/.mars/worktrees`]: [worktreeId] },
      ),
    )

    const check = listChecks().find((c) => c.id === 'repo.layout.fragmented')!
    const outcome = await check.run({ prereqs: new Set(['git', 'fs']) })

    expect(outcome.ok).toBe(true)
  })

  // ── Fragmented fixture ─────────────────────────────────────────────────────

  it('reports ok=false with findingKey repo.layout.fragmented when virtual store escapes', async () => {
    const { wireRepoLayoutFragmentedCheck } = await import('../checks/repo-layout-fragmented.js')
    const { listChecks } = await import('../registry.js')

    const repoRoot = '/repo'
    const worktreeId = 'mars-def456'
    const worktreePath = `/repo/.mars/worktrees/${worktreeId}`
    // Virtual store pointing at the main checkout's node_modules — escaped!
    const escapedVsd = '/repo/node_modules/.pnpm'

    wireRepoLayoutFragmentedCheck(
      makeStubDeps(
        repoRoot,
        { [`${worktreePath}/node_modules/.modules.yaml`]: modulesYaml(escapedVsd) },
        { [`${repoRoot}/.mars/worktrees`]: [worktreeId] },
      ),
    )

    const check = listChecks().find((c) => c.id === 'repo.layout.fragmented')!
    const outcome = await check.run({ prereqs: new Set(['git', 'fs']) })

    expect(outcome.ok).toBe(false)
    expect(outcome.findingKey).toBe('repo.layout.fragmented')
    expect(outcome.detail).toBeTruthy()
  })

  it('detail names the affected worktree', async () => {
    const { wireRepoLayoutFragmentedCheck } = await import('../checks/repo-layout-fragmented.js')
    const { listChecks } = await import('../registry.js')

    const repoRoot = '/repo'
    const worktreeId = 'mars-named-worktree'
    const worktreePath = `/repo/.mars/worktrees/${worktreeId}`
    const escapedVsd = '/repo/node_modules/.pnpm'

    wireRepoLayoutFragmentedCheck(
      makeStubDeps(
        repoRoot,
        { [`${worktreePath}/node_modules/.modules.yaml`]: modulesYaml(escapedVsd) },
        { [`${repoRoot}/.mars/worktrees`]: [worktreeId] },
      ),
    )

    const check = listChecks().find((c) => c.id === 'repo.layout.fragmented')!
    const outcome = await check.run({ prereqs: new Set(['git', 'fs']) })

    expect(outcome.detail).toContain(worktreeId)
  })

  // ── No worktrees directory ─────────────────────────────────────────────────

  it('reports ok=true when the worktrees directory is absent (fresh install)', async () => {
    const { wireRepoLayoutFragmentedCheck } = await import('../checks/repo-layout-fragmented.js')
    const { listChecks } = await import('../registry.js')

    wireRepoLayoutFragmentedCheck(
      makeStubDeps('/repo', {}, {}), // readDir returns [] for all paths
    )

    const check = listChecks().find((c) => c.id === 'repo.layout.fragmented')!
    const outcome = await check.run({ prereqs: new Set(['git', 'fs']) })

    expect(outcome.ok).toBe(true)
  })

  // ── Missing .modules.yaml ─────────────────────────────────────────────────

  it('skips a worktree with no .modules.yaml (install not yet materialised)', async () => {
    const { wireRepoLayoutFragmentedCheck } = await import('../checks/repo-layout-fragmented.js')
    const { listChecks } = await import('../registry.js')

    const repoRoot = '/repo'
    wireRepoLayoutFragmentedCheck(
      makeStubDeps(
        repoRoot,
        {}, // no files — readFile returns null for all paths
        { [`${repoRoot}/.mars/worktrees`]: ['mars-no-install'] },
      ),
    )

    const check = listChecks().find((c) => c.id === 'repo.layout.fragmented')!
    const outcome = await check.run({ prereqs: new Set(['git', 'fs']) })

    // Worktree has no node_modules yet — conservative pass
    expect(outcome.ok).toBe(true)
  })

  // ── Mixed fixture: one clean, one fragmented ───────────────────────────────

  it('reports fragmented when at least one worktree has an escaped virtual store', async () => {
    const { wireRepoLayoutFragmentedCheck } = await import('../checks/repo-layout-fragmented.js')
    const { listChecks } = await import('../registry.js')

    const repoRoot = '/repo'
    const cleanId = 'mars-clean'
    const brokenId = 'mars-broken'
    const cleanPath = `/repo/.mars/worktrees/${cleanId}`
    const brokenPath = `/repo/.mars/worktrees/${brokenId}`

    wireRepoLayoutFragmentedCheck(
      makeStubDeps(
        repoRoot,
        {
          [`${cleanPath}/node_modules/.modules.yaml`]: modulesYaml(
            `${cleanPath}/node_modules/.pnpm`,
          ),
          [`${brokenPath}/node_modules/.modules.yaml`]: modulesYaml('/repo/node_modules/.pnpm'),
        },
        {
          [`${repoRoot}/.mars/worktrees`]: [cleanId, brokenId],
        },
      ),
    )

    const check = listChecks().find((c) => c.id === 'repo.layout.fragmented')!
    const outcome = await check.run({ prereqs: new Set(['git', 'fs']) })

    expect(outcome.ok).toBe(false)
    expect(outcome.findingKey).toBe('repo.layout.fragmented')
  })

  // ── Idempotent enqueue via healthPass ─────────────────────────────────────

  it('enqueues exactly one fix task across repeated passes while the task is active', async () => {
    const { wireRepoLayoutFragmentedCheck } = await import('../checks/repo-layout-fragmented.js')
    const { healthPass } = await import('../pass.js')
    type HealthPassDeps = import('../pass.js').HealthPassDeps

    const repoRoot = '/repo'
    const worktreeId = 'mars-fragmented'
    const worktreePath = `/repo/.mars/worktrees/${worktreeId}`
    const escapedVsd = '/repo/node_modules/.pnpm'

    wireRepoLayoutFragmentedCheck(
      makeStubDeps(
        repoRoot,
        { [`${worktreePath}/node_modules/.modules.yaml`]: modulesYaml(escapedVsd) },
        { [`${repoRoot}/.mars/worktrees`]: [worktreeId] },
      ),
    )

    const activeTasks = new Set<string>()
    let enqueueCount = 0

    const fix: HealthPassDeps['fix'] = {
      hasActiveTaskForFinding: async (key: string) => activeTasks.has(key),
      enqueueFixTask: async ({ findingKey }: { findingKey: string; checkId: string; detail: string | undefined }) => {
        enqueueCount++
        activeTasks.add(findingKey)
        return `task-${enqueueCount}`
      },
    }

    // First pass — check is registered via the import above → enqueues
    const s1 = await healthPass({ ctx: { prereqs: new Set(['git', 'fs']) }, fix })
    expect(s1.enqueued).toHaveLength(1)
    expect(enqueueCount).toBe(1)

    // Second pass — task still active → no duplicate enqueue
    const s2 = await healthPass({ ctx: { prereqs: new Set(['git', 'fs']) }, fix })
    expect(s2.enqueued).toHaveLength(0)
    expect(s2.alreadyActive).toHaveLength(1)
    expect(enqueueCount).toBe(1)
  })
})
