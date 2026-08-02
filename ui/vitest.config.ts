import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
    // Three inline projects so each runs with its own environment and timeout:
    //   node   — src/ unit tests (no DOM), 5 s default timeout
    //   server — every server/**/*.test.ts, 60 s (real HTTP server + PGlite)
    //   dom    — happy-dom: Composer + ChatPage interactive tests
    projects: [
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
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
          ],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: sharedAlias },
        test: {
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
          ],
        },
      },
    ],
  },
})
