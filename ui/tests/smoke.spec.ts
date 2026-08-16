import { test, expect } from 'playwright/test'

/**
 * @smoke suite — verifies the Mars UI boots correctly from a production
 * build.  Runs against `vite preview` (no live daemon), so assertions
 * cover only static chrome that does not depend on API data.
 *
 * Tagged via the describe block name so `--grep @smoke` picks them up:
 *   playwright test --config playwright.smoke.config.ts --grep @smoke
 *
 * Selector rationale:
 *
 *   Sidebar — `<nav aria-label="Main navigation">` is the ShellSidebar
 *   element rendered by Shell.tsx.  Each of the three nav groups is
 *   labelled with a `<p>` containing the group name (Workspace /
 *   Developer / Intel).  These labels are static — no API call required.
 *
 *   Progress board — ProgressPage always renders a `<main>` wrapper once
 *   the React tree has mounted, even without API data (the board shows an
 *   empty or loading state rather than crashing).  Asserting the `<main>`
 *   is visible proves the route resolved and the component mounted.
 */
test.describe('@smoke', () => {
  test('Shell sidebar renders all three nav groups', async ({ page }) => {
    // Root redirects to #/chat; the Shell (and its sidebar) is always present.
    await page.goto('/')

    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })

    // All three group headings must appear in the sidebar.
    await expect(nav.getByText('Workspace')).toBeVisible()
    await expect(nav.getByText('Developer')).toBeVisible()
    await expect(nav.getByText('Intel')).toBeVisible()
  })

  test('#/progress renders the board shell', async ({ page }) => {
    // `?view=board` activates the BoardView tab on mount.
    await page.goto('/#/progress?view=board')

    // ProgressPage wraps its content in a `<main>`.  Verifying it is
    // visible confirms the route resolved and React mounted successfully.
    await expect(page.locator('main')).toBeVisible({ timeout: 15_000 })
  })
})
