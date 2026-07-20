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
      'src/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    // Exclude template scaffolding and any nested worktree checkouts so a
    // stray `agent-*` directory under src/init/templates/claude/worktrees/
    // (a nested git checkout, has happened before) can never poison the
    // suite by getting picked up as real tests.
    exclude: [
      ...configDefaults.exclude,
      '**/src/init/templates/**',
      '**/worktrees/**',
    ],
    environment: 'node',
    // Turn ON the Arc-invariant debug-assert seam for the whole suite (ADR-0052)
    // so every arc-mutating test exercises Arc.assertArcInvariant after commit.
    setupFiles: ['./test/setup-env.ts'],
  },
})
