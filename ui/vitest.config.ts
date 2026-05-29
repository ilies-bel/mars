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
  },
})
