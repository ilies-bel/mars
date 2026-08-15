import { test, expect } from 'playwright/test'

/**
 * SPA smoke test — verifies the Mars UI boots and renders its two primary
 * surfaces without crashing.
 *
 * Selector rationale (no invented data-testids):
 *
 *   Kanban board — `#/progress?view=board` forces the board view.  Each
 *   lifecycle column is wrapped in a `<div data-cluster="...">` element inside
 *   a `<main>`.  All four column wrappers are always in the DOM once
 *   BoardView mounts, so asserting at least one `[data-cluster]` child proves
 *   the board rendered successfully.
 *
 *   Action-queue panel — `#/chat` is the default landing page.  When no
 *   thread is pinned, the reading pane renders `[data-testid="seeded-feed"]`
 *   which always has at least two direct children: the transcript scroll
 *   container and the jump-to-bottom button.
 */
test('SPA renders kanban and action queue', async ({ page }) => {
  // ── Kanban board ──────────────────────────────────────────────────────────
  // `?view=board` is a real URL param the ProgressPage reads on mount to
  // select the board tab (default is topology).  The board view renders four
  // lifecycle columns with `data-cluster` attributes inside a `<main>`.
  await page.goto('/#/progress?view=board')

  const kanbanBoard = page.locator('main:has([data-cluster])')
  await expect(kanbanBoard).toBeVisible({ timeout: 15_000 })
  // At least one lifecycle column (`data-cluster="Running"` etc.) is present.
  await expect(kanbanBoard.locator('[data-cluster]')).not.toHaveCount(0)

  // ── Action-queue / chat panel ─────────────────────────────────────────────
  await page.goto('/#/chat')

  // The seeded feed (main reading pane when no thread is selected) is always
  // present in the initial render: it contains the transcript scroll container
  // and the jump-to-bottom button at minimum.
  const seededFeed = page.locator('[data-testid="seeded-feed"]')
  await expect(seededFeed).toBeVisible({ timeout: 15_000 })
  await expect(seededFeed.locator('> *')).not.toHaveCount(0)
})
