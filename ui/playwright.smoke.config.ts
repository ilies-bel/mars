import { defineConfig } from 'playwright/test'

/**
 * Playwright config for the @smoke suite.
 *
 * Smoke tests run against `vite preview` (the built bundle, not the dev
 * server) so the caller must build before invoking playwright:
 *
 *   npm run build && playwright test --config playwright.smoke.config.ts
 *
 * The `npm run test:e2e` script does this automatically.
 *
 * Port 14173 is chosen to avoid collisions with the default Vite preview
 * port (4173), which may already be in use by `mars ui` or another
 * worktree's preview server in multi-task CI environments.
 */
export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://127.0.0.1:14173',
    // Always run headless — smoke runs must not pop a browser window.
    headless: true,
  },
  webServer: {
    command: 'vite preview --port 14173',
    url: 'http://127.0.0.1:14173',
    reuseExistingServer: !process.env.CI,
    // vite preview starts quickly once the bundle exists; 60 s is generous.
    timeout: 60_000,
  },
})
