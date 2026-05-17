import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    environment: 'node',
  },
})
