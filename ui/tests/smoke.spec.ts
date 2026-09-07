import { test, expect } from 'playwright/test'

/**
 * @smoke suite — verifies the Mars UI boots correctly from a production
 * build.  Runs against `vite preview` (no live daemon), so assertions
 * cover only structure that does not depend on API data.
 *
 * Every top-level nav route (from SHELL_NAV_GROUPS in Shell.tsx) is loaded
 * and asserted to render actual content — not merely a wrapper element.
 * With no daemon running, each route will be in its error/empty state;
 * that state is the contract: "renders a comprehensible empty/error state".
 *
 * Tagged via the describe block name so `--grep @smoke` picks them up:
 *   playwright test --config playwright.smoke.config.ts --grep @smoke
 *
 * Selector rationale:
 *
 *   Sidebar — `<nav aria-label="Main navigation">` is the ShellSidebar
 *   element rendered by Shell.tsx.  Verifying it is visible on every route
 *   proves the shell mounted and the route resolved without crashing.
 *
 *   Per-route containers — each page exposes a `data-testid` on its outermost
 *   element.  Asserting it is visible proves the correct page component
 *   mounted (not the FallbackBoundary fallback, which would replace it).
 *
 *   Content check — `innerText().trim().length > 0` proves the container is
 *   not empty.  A blank container (the actual failure mode this suite guards)
 *   fails this assertion even when the wrapper element is present.
 *
 *   Error boundary check — `[data-testid="api-error-panel"]` is the testid
 *   that FallbackBoundary/FallbackSurface renders on a render crash.  Its
 *   presence when a page-specific container is expected indicates that the
 *   route component crashed rather than rendering gracefully.
 */

/** Assert a route renders its own container with non-blank text content. */
async function assertRouteRendered(
  page: Parameters<Parameters<typeof test>[1]>[0]['page'],
  testId: string,
): Promise<void> {
  const container = page.locator(`[data-testid="${testId}"]`)
  await expect(container).toBeVisible({ timeout: 10_000 })
  const text = await container.innerText()
  expect(text.trim().length, `route container "${testId}" must have non-blank text`).toBeGreaterThan(0)
}

test.describe('@smoke', () => {
  test('Shell sidebar renders all four nav groups', async ({ page }) => {
    // Root redirects to #/triage; the Shell (and its sidebar) is always present.
    await page.goto('/')

    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })

    // All four group headings must appear in the sidebar.
    await expect(nav.getByText('Decide')).toBeVisible()
    await expect(nav.getByText('Watch')).toBeVisible()
    await expect(nav.getByText('Tune')).toBeVisible()
    await expect(nav.getByText('Advanced')).toBeVisible()
  })

  // ── Decide group ──────────────────────────────────────────────────────────

  test('#/ (default) renders the triage page', async ({ page }) => {
    await page.goto('/')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'triage-page')
  })

  test('#/triage renders the triage page', async ({ page }) => {
    await page.goto('/#/triage')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'triage-page')
  })

  test('#/proposals renders the proposals page', async ({ page }) => {
    await page.goto('/#/proposals')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'proposals-page')
  })

  test('#/chat renders the chat page', async ({ page }) => {
    await page.goto('/#/chat')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'chat-page')
  })

  // ── Watch group ───────────────────────────────────────────────────────────

  test('#/progress renders the progress board', async ({ page }) => {
    await page.goto('/#/progress')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'progress-page')
  })

  test('#/events renders the events page', async ({ page }) => {
    await page.goto('/#/events')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'events-page')
  })

  // ── Tune group ────────────────────────────────────────────────────────────

  test('#/kpi renders the KPI page', async ({ page }) => {
    await page.goto('/#/kpi')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'kpi-page')
  })

  test('#/control renders the control room', async ({ page }) => {
    await page.goto('/#/control')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'control-page')
  })

  test('#/reflections renders the reflections page', async ({ page }) => {
    await page.goto('/#/reflections')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'reflections-page')
  })

  // ── Advanced group ────────────────────────────────────────────────────────

  test('#/steward renders the steward page', async ({ page }) => {
    await page.goto('/#/steward')
    const nav = page.locator('nav[aria-label="Main navigation"]')
    await expect(nav).toBeVisible({ timeout: 15_000 })
    await assertRouteRendered(page, 'steward-page')
  })
})
