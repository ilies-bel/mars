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
 *   element rendered by Shell.tsx.  Each of the four nav groups is
 *   labelled with a `<p>` containing the group name (Decide / Watch /
 *   Tune / Advanced).  These labels are static — no API call required.
 *   Source of truth: SHELL_NAV_GROUPS in ui/src/widgets/Shell.tsx.
 *
 *   Progress board — ProgressPage always renders a `<main>` wrapper once
 *   the React tree has mounted, even without API data (the board shows an
 *   empty or loading state rather than crashing).  Asserting the `<main>`
 *   is visible proves the route resolved and the component mounted.
 */
test.describe('@smoke', () => {
  test('Shell sidebar renders all four nav groups', async ({ page }) => {
    // Root redirects to #/chat; the Shell (and its sidebar) is always present.
    await page.goto('/')

    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })

    // All four group headings must appear in the sidebar.
    await expect(nav.getByText('Decide')).toBeVisible()
    await expect(nav.getByText('Watch')).toBeVisible()
    await expect(nav.getByText('Tune')).toBeVisible()
    await expect(nav.getByText('Advanced')).toBeVisible()
  })

  test('#/progress renders the board shell', async ({ page }) => {
    // `?view=board` activates the BoardView tab on mount.
    await page.goto('/#/progress?view=board')

    // ProgressPage wraps its content in a `<main>`.  Verifying it is
    // visible confirms the route resolved and React mounted successfully.
    await expect(page.locator('main')).toBeVisible({ timeout: 15_000 })
  })
})
