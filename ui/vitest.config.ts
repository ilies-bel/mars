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
    // Two inline projects so each runs with its own environment:
    //   node    — all existing src/ tests + server tests (no DOM needed)
    //   happy-dom — Composer interactive tests (chip add/remove, send flow)
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
          // keyboard tests), plus EVERY server/ test.
          //
          // Both entries are globs on purpose. This list used to name nine
          // server files one by one; ui/server/ grew to 21 and the list was
          // never updated, so ui/server/chatRoutes.test.ts executed under no
          // runner at all. A glob cannot go stale.
          //
          // Server tests written against `bun:test` run here too — the
          // `bun:test` alias above points at src/bun-test-compat.ts.
          include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.ts'],
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
