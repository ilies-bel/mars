import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Redirect bun:test imports to the compatibility shim so that test files
      // written for Bun's test runner also execute under `npx vitest run`.
      // The shim re-exports vitest primitives and bridges the API gaps
      // (`mock` → vi.fn, `spyOn` → vi.spyOn).
      'bun:test': path.resolve(__dirname, 'src/bun-test-compat.ts'),
    },
  },
  test: {
    environment: 'node',
    // Include all src/ tests plus the server tests that use Node.js HTTP and
    // mocks (i.e. don't require Bun.serve()). All other server/*.test.ts files
    // start a Bun.serve() HTTP server and can only run under `bun test`
    // (the `npm run test:server` half of the suite).
    include: [
      'src/**/*.test.{ts,tsx}',
      'server/kpis.test.ts',
      'server/projectHealth.test.ts',
      'server/projectsStart.test.ts',
      'server/projectContext.test.ts',
      'server/projects.test.ts',
    ],
  },
})
