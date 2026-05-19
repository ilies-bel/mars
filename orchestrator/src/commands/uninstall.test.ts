import { describe, it, expect } from 'vitest'
import { runUninstall } from './uninstall.js'
import type { UninstallDeps } from './uninstall.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build an UninstallDeps where both paths exist and confirm returns true. */
function makeDeps(
  overrides: Partial<UninstallDeps> & { existingPaths?: Set<string> } = {},
): UninstallDeps & { removed: string[]; logged: string[] } {
  const removed: string[] = []
  const logged: string[] = []
  const existingPaths: Set<string> =
    overrides.existingPaths ??
    new Set(['/home/user/.local/bin/mars', '/home/user/mars-framework'])

  return {
    removed,
    logged,
    exists: overrides.exists ?? ((p) => existingPaths.has(p)),
    removeFile:
      overrides.removeFile ??
      (async (p) => {
        removed.push(`file:${p}`)
      }),
    removeDir:
      overrides.removeDir ??
      (async (p) => {
        removed.push(`dir:${p}`)
      }),
    confirm: overrides.confirm ?? (async () => true),
    log:
      overrides.log ??
      ((msg) => {
        logged.push(msg)
      }),
  }
}

const WRAPPER = '/home/user/.local/bin/mars'
const CLONE = '/home/user/mars-framework'

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runUninstall — full success', () => {
  it('removes the wrapper file on a confirmed full-success run', async () => {
    const deps = makeDeps()
    const result = await runUninstall(WRAPPER, CLONE, deps)

    expect(result.outcome).toBe('full-success')
    expect(deps.removed).toContain(`file:${WRAPPER}`)
  })

  it('removes the source clone directory on a confirmed full-success run', async () => {
    const deps = makeDeps()
    const result = await runUninstall(WRAPPER, CLONE, deps)

    expect(result.outcome).toBe('full-success')
    expect(deps.removed).toContain(`dir:${CLONE}`)
  })

  it('prints a shell rc PATH reminder on full success', async () => {
    const deps = makeDeps()
    await runUninstall(WRAPPER, CLONE, deps)

    const reminder = deps.logged.some((msg) =>
      /shell\s+rc|\.bashrc|\.zshrc|PATH/i.test(msg),
    )
    expect(reminder).toBe(true)
  })
})

describe('runUninstall — deletion order invariant', () => {
  it('wrapper is deleted before the source clone is attempted', async () => {
    // Make removeDir throw — after the throw, verify the wrapper is already gone.
    const callOrder: string[] = []
    const deps = makeDeps({
      removeFile: async (p) => {
        callOrder.push(`file:${p}`)
      },
      removeDir: async (_p) => {
        // Simulate a failure partway through; the wrapper must already be removed.
        throw new Error('simulated clone removal failure')
      },
    })

    await expect(runUninstall(WRAPPER, CLONE, deps)).rejects.toThrow(
      'simulated clone removal failure',
    )

    // Wrapper was already deleted before removeDir was attempted.
    expect(callOrder).toContain(`file:${WRAPPER}`)
  })
})

describe('runUninstall — partial-state: source clone already absent', () => {
  it('still removes the wrapper when the source clone is already gone', async () => {
    const deps = makeDeps({
      existingPaths: new Set([WRAPPER]), // clone is absent
    })
    const result = await runUninstall(WRAPPER, CLONE, deps)

    expect(result.outcome).toBe('source-already-absent')
    expect(deps.removed).toContain(`file:${WRAPPER}`)
  })

  it('prints "source clone already absent" when clone is missing', async () => {
    const deps = makeDeps({
      existingPaths: new Set([WRAPPER]),
    })
    await runUninstall(WRAPPER, CLONE, deps)

    const mentioned = deps.logged.some((msg) =>
      /source clone already absent/i.test(msg),
    )
    expect(mentioned).toBe(true)
  })

  it('exits 0 (no thrown error) when source clone is already absent', async () => {
    const deps = makeDeps({
      existingPaths: new Set([WRAPPER]),
    })
    await expect(runUninstall(WRAPPER, CLONE, deps)).resolves.not.toThrow()
  })
})

describe('runUninstall — partial-state: wrapper already absent', () => {
  it('still removes the source clone when the wrapper is already gone', async () => {
    const deps = makeDeps({
      existingPaths: new Set([CLONE]), // wrapper is absent
    })
    const result = await runUninstall(WRAPPER, CLONE, deps)

    expect(result.outcome).toBe('wrapper-already-absent')
    expect(deps.removed).toContain(`dir:${CLONE}`)
  })

  it('prints "wrapper already absent" when wrapper is missing', async () => {
    const deps = makeDeps({
      existingPaths: new Set([CLONE]),
    })
    await runUninstall(WRAPPER, CLONE, deps)

    const mentioned = deps.logged.some((msg) =>
      /wrapper already absent/i.test(msg),
    )
    expect(mentioned).toBe(true)
  })
})

describe('runUninstall — no .mars/ directories touched', () => {
  it('never passes a .mars/ or .worktrees/ path to removeFile or removeDir', async () => {
    const touched: string[] = []
    const deps = makeDeps({
      removeFile: async (p) => {
        touched.push(p)
      },
      removeDir: async (p) => {
        touched.push(p)
      },
    })
    await runUninstall(WRAPPER, CLONE, deps)

    for (const p of touched) {
      expect(p).not.toMatch(/\.(mars|worktrees)/)
    }
  })
})

describe('runUninstall — cancelled', () => {
  it('returns cancelled outcome when user does not confirm', async () => {
    const deps = makeDeps({
      confirm: async () => false,
    })
    const result = await runUninstall(WRAPPER, CLONE, deps)

    expect(result.outcome).toBe('cancelled')
    expect(deps.removed).toHaveLength(0)
  })
})
