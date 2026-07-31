import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@libsql/client': fileURLToPath(
        new URL('./src/test/libsql-test-adapter.ts', import.meta.url),
      ),
      // The orchestrator consumes the in-house workflow engine straight from
      // source (no build step — the package `exports` points at its raw
      // `src/index.ts`). Mirror the tsconfig `paths` alias here so vitest's
      // vite resolver finds the same entry; vite resolves the package's
      // internal `.js` specifiers to their `.ts` sources automatically.
      '@mars/workflow': fileURLToPath(
        new URL('../packages/workflow/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.tsx',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'test/**/*.test.ts',
    ],
    // Exclude template scaffolding, including its nested worktree checkouts,
    // so a stray `agent-*` checkout under src/init/templates/claude/worktrees/
    // can never poison the suite by getting picked up as real tests.
    exclude: [
      ...configDefaults.exclude,
      '**/src/init/templates/**',
    ],
    environment: 'node',
    // -------------------------------------------------------------------------
    // Merge-gate reliability guardrails — DO NOT lower without an ADR
    //
    // These settings are intentional constraints that keep the PGlite-backed
    // test suite repeatable on the CI merge gate and on developer machines
    // running many parallel worktrees.  Changing them requires an Architecture
    // Decision Record (docs/adr/) that demonstrates the new values preserve
    // those guarantees.
    //
    // testTimeout / hookTimeout (30 s each)
    //   PGlite cold-start takes 5-25 s per test that calls vi.resetModules() +
    //   dynamic import (or boots a fresh instance in beforeEach). The default
    //   5 s timeout is too tight for those tests when many instances run
    //   concurrently. 30 s gives enough headroom without hiding real hangs.
    //
    // pool: 'forks' with maxForks=1 (single-fork)
    //   The orchestrator runs many coder tasks in parallel, each doing a full
    //   `npm test`; vitest otherwise sizes the forks pool to the host core
    //   count (~9 forks here), so N parallel suites × ~9 forks exhausts RAM
    //   and OOM-kills the daemon (observed 2026-07-21: repeated daemon deaths +
    //   orphaned fork storms at load ~200). One fork per suite trades slower
    //   per-suite wall time for ~9× less memory so the aggregate stays bounded
    //   no matter how many suites run at once. A single fork also prevents port
    //   contention between concurrent PGlite clusters that would otherwise
    //   fight over the same Postgres listen port.
    //   Override on an idle machine via VITEST_MAX_FORKS.
    // -------------------------------------------------------------------------
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: Number(process.env.VITEST_MAX_FORKS ?? 1),
        minForks: Number(process.env.VITEST_MIN_FORKS ?? 1),
      },
    },
    // Turn ON the Arc-invariant debug-assert seam for the whole suite (ADR-0052)
    // so every arc-mutating test exercises Arc.assertArcInvariant after commit.
    setupFiles: ['./test/setup-env.ts'],
    // Reclaim the PGlite test clusters the suites leak into $TMPDIR. Runs once,
    // after all workers exit, so the DB files are unlocked. See the file header
    // for why this is necessary (per-task `verify` accumulated ~400 GB).
    globalSetup: ['./test/global-teardown.ts'],
  },
})
