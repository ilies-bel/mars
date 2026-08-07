import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// -----------------------------------------------------------------------------
// Merge-gate reliability guardrail — mirrored from orchestrator/vitest.config.ts
//
// Mars runs many coder tasks in parallel, each doing a full `npm test`. Vitest
// otherwise sizes the forks pool to the host core count (~9 forks here), and
// this config declares FOUR projects, so one suite alone can spawn ~4×9 forks.
// N parallel worktrees × that fan-out exhausts RAM and starves the host.
//
// Observed 2026-07-21 (orchestrator): repeated daemon deaths + orphaned fork
// storms at load ~200 — which is why orchestrator/vitest.config.ts pins
// maxForks=1. That bound was never copied here, and on 2026-08-07 this config
// reproduced the same incident from the UI side: 8 implement tasks, 111 vitest
// processes, load 210 on 10 cores, zero task completions in 15 minutes.
//
// One fork per suite trades slower per-suite wall time for a bounded aggregate
// no matter how many suites run at once. Override on an idle machine via
// VITEST_MAX_FORKS. Do not remove without an ADR — and if you change it, change
// orchestrator/vitest.config.ts in the same commit so the two cannot drift again.
//
// Applied to the root `test` block AND to every project: inline projects do not
// reliably inherit pool settings across vitest versions, and a silent
// non-inherit here is exactly the failure this guard exists to prevent.
// -----------------------------------------------------------------------------
// Vitest 4 reworked the pool API: `poolOptions` was removed; `maxForks` is now
// the top-level `maxWorkers`. The `VITEST_MAX_WORKERS` env var is also read
// automatically by vitest 4, but we set the default here explicitly so the
// bound is visible in config (not a hidden env-var-only behaviour). We also
// honour the legacy `VITEST_MAX_FORKS` name so operator runbooks written for
// the orchestrator config still work without change.
// See: https://vitest.dev/guide/migration#pool-rework
const boundedPool = {
  pool: 'forks' as const,
  maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? process.env.VITEST_MAX_FORKS ?? 1),
}

/** Shared resolve aliases used by all test projects. */
const sharedAlias = {
  '@': path.resolve(__dirname, 'src'),
  // Redirect bun:test imports to the compatibility shim so that test files
  // written for Bun's test runner also execute under `npx vitest run`.
  // The shim re-exports vitest primitives and bridges the API gaps
  // (`mock` → vi.fn, `spyOn` → vi.spyOn).
  'bun:test': path.resolve(__dirname, 'src/bun-test-compat.ts'),
}

export default defineConfig({
  plugins: [react()],
  resolve: { alias: sharedAlias },
  test: {
    ...boundedPool,
    // Three inline projects so each runs with its own environment and timeout:
    //   node   — src/ unit tests (no DOM), 5 s default timeout
    //   server — every server/**/*.test.ts, 60 s (real HTTP server + PGlite)
    //   dom    — happy-dom: Composer + ChatPage interactive tests
    projects: [
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
          ...boundedPool,
          name: 'node',
          environment: 'node',
          // Provide minimal Bun runtime globals so tests written against Bun's
          // API (Bun.serve, Bun.write) also execute under `npx vitest run`.
          setupFiles: ['server/__testing__/bun-vitest-setup.ts'],
          // Every src/ test EXCEPT *.composer.test.* (those need DOM) and the
          // ChatPage suites (moved to the dom project for slash-palette
          // keyboard tests). Pure unit tests — they keep vitest's tight 5 s
          // default timeout so a hang shows up as a failure, not a stall.
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [
            'src/**/*.composer.test.tsx',
            'src/pages/ChatPage.test.tsx',
            'src/pages/ChatPage.queue.test.tsx',
            'src/pages/ChatPage.run-control.test.tsx',
            'src/pages/ChatComposerAttachments.test.tsx',
            // Moved to the dom project: contain interactive click tests that
            // require a real DOM environment (happy-dom) and createRoot+act.
            'src/widgets/TopologyView.test.tsx',
            'src/pages/ProgressPage.test.tsx',
          ],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
          ...boundedPool,
          name: 'contracts',
          environment: 'node',
          include: [],
          typecheck: {
            enabled: true,
            include: ['src/shared/trace-events.contract.test.ts'],
            exclude: [],
            tsconfig: 'tsconfig.contract.json',
          },
        },
      },
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
          ...boundedPool,
          name: 'server',
          environment: 'node',
          setupFiles: ['server/__testing__/bun-vitest-setup.ts'],
          // EVERY server test, by glob. This used to be nine filenames listed
          // one by one inside the 'node' project while ui/server/ grew to 21,
          // so ui/server/chatRoutes.test.ts executed under no runner at all.
          // A glob cannot go stale.
          //
          // Server tests written against `bun:test` run here too — the
          // `bun:test` alias above points at src/bun-test-compat.ts.
          include: ['server/**/*.test.ts'],
          // Separate project purely for the timeout. These boot a real HTTP
          // server and a PGlite database per test; a PGlite cold start alone
          // can take 5-25 s under load (same reason orchestrator/vitest.config.ts
          // runs at 60 s). Under the 5 s default, stepSpans.test.ts failed
          // intermittently with "Test timed out in 5000ms". Keeping this out of
          // the 'node' project means the ~113 src unit-test files are not given
          // a 60 s licence to hang.
          //
          // PGlite startup is occasionally slower than the observed 36 s
          // worst-case test runtime under load. Keep enough headroom for a
          // loaded machine while individual suites share their real fixture
          // where isolation permits.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
          ...boundedPool,
          name: 'dom',
          environment: 'happy-dom',
          // Composer interactive tests + ChatPage.test.tsx (slash-palette keyboard tests
          // require a real DOM; SSR-based tests also work fine under happy-dom).
          include: [
            'src/**/*.composer.test.tsx',
            'src/pages/ChatPage.test.tsx',
            'src/pages/ChatPage.queue.test.tsx',
            'src/pages/ChatPage.run-control.test.tsx',
            'src/pages/ChatComposerAttachments.test.tsx',
            // Interactive click tests that require a real DOM environment.
            'src/widgets/TopologyView.test.tsx',
            'src/pages/ProgressPage.test.tsx',
          ],
        },
      },
    ],
  },
})
