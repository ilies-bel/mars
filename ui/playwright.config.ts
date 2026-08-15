import { defineConfig } from 'playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Run tests headlessly in CI; reuse the already-running dev server locally
  // to avoid the 120 s boot wait every time a developer runs the suite.
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    // In CI (process.env.CI is set) always boot a fresh server.
    // Locally, reuse whatever is already listening on port 5173.
    reuseExistingServer: !process.env.CI,
    // Local Vite dev server typically starts in < 5 s; allow up to 120 s for
    // slow machines or cold npm caches.
    timeout: 120_000,
  },
})
