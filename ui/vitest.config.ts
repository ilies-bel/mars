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
          // Include all src/ tests EXCEPT *.composer.test.* (those need DOM)
          // and ChatPage.test.tsx (moved to dom to support slash-palette keyboard tests)
          // plus the server tests that use Node.js HTTP and mocks.
          include: [
            'src/**/*.test.{ts,tsx}',
            'server/daemonHttp.test.ts',
            'server/kpis.test.ts',
            'server/projectHealth.test.ts',
            'server/projectsStart.test.ts',
            'server/projectContext.test.ts',
            'server/projects.test.ts',
            'server/chatUploads.test.ts',
          ],
          exclude: [
            'src/**/*.composer.test.tsx',
            'src/pages/ChatPage.test.tsx',
            'src/pages/ChatPage.queue.test.tsx',
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
          ],
        },
      },
    ],
  },
})
