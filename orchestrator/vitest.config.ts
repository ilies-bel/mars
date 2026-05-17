import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
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
  },
})
