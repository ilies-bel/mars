/**
 * E2E spec for the ProposalRow expand/collapse body text behavior.
 *
 * renderToStaticMarkup-based unit tests (ProposalCard.test.tsx) can assert
 * that CSS class names are present in the markup, but they cannot evaluate
 * computed styles or simulate the click -> state-change -> re-render cycle.
 * This spec covers exactly those interactive surfaces:
 *
 *   1. The body paragraph has CSS line-clamp applied in the collapsed state.
 *   2. A "more" affordance (button[aria-expanded="false"]) is visible.
 *   3. Clicking it flips aria-expanded to "true" and removes the clamp class.
 *
 * Selector rationale -- no invented data-testids:
 *
 *   body paragraph   -- "p.line-clamp-3" inside ".mars-card" (ProposalRow's
 *                        root div) when collapsed; ProposalsPage.tsx ~line 104.
 *   expand button    -- ".mars-card button[aria-expanded]"; the only
 *                        button with aria-expanded on the proposals route.
 *
 * API stub rationale:
 *
 *   The test intercepts the proposals API and returns a single fixture
 *   proposal whose problem field is long enough to overflow three lines at
 *   any reasonable card width. This makes the spec hermetic: it does not
 *   depend on the daemon being up, having data seeded, or returning any
 *   specific proposal.
 */

import { test, expect } from 'playwright/test'

// ── Fixture ───────────────────────────────────────────────────────────────────

// A body text that is long enough to overflow a three-line clamp at typical
// card widths regardless of the font size the browser chooses.  The content
// is plain prose; it does not rely on specific line-break positions.
const LONG_PROBLEM =
  'First paragraph: background on this problem and why it matters to the ' +
  'operator.  The text is deliberately long so that it overflows the ' +
  'three-line clamp applied by ProposalRow in the collapsed state. ' +
  'Second paragraph: more context that pushes well past the fold.  ' +
  'This content should remain invisible while the card is collapsed and ' +
  'become visible only after the operator clicks the expand affordance. ' +
  'Third paragraph: additional details that confirm the full body ' +
  'is truly rendered in the DOM even when the CSS clips it visually.'

const FIXTURE = {
  id: 'e2e-proposals-expand-01',
  title: 'E2E fixture: expand/collapse body text',
  problem: LONG_PROBLEM,
  solution: 'Covered by the spec.',
  status: 'draft',
  source: 'human',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  acceptanceCount: 0,
  userStories: [],
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test(
  'proposals page expand/collapse: clamped body, visible affordance, click reveals text',
  async ({ page }) => {
    // Stub the proposals API so this test is hermetic: no daemon required, no
    // seeded data.  The stub returns our single fixture proposal with a long
    // problem body, guaranteeing a line-clamp overflow at any card width.
    await page.route('**/api/proposals**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ drafts: [FIXTURE], total: 1, nextCursor: null }),
      }),
    )

    await page.goto('/#/proposals')

    // ── Criterion 1: body text is visually clamped in the collapsed state ───
    //
    // ProposalRow applies class "line-clamp-3" to the body paragraph when
    // collapsed (ProposalsPage.tsx ~line 104).  We assert both that the
    // class is present (via the locator) and that the browser has applied
    // the CSS: webkitLineClamp should be '3' (Tailwind's line-clamp-3
    // utility sets -webkit-line-clamp: 3) OR the scroll height exceeds
    // the visible height (the element overflows its clipped box).
    const bodyPara = page.locator('.mars-card p.line-clamp-3').first()
    await expect(bodyPara).toBeVisible({ timeout: 15_000 })

    const isClamped = await bodyPara.evaluate((el) => {
      const cs = getComputedStyle(el)
      // webkitLineClamp is the canonical check for -webkit-line-clamp: 3.
      // scrollHeight > clientHeight is the fallback for browsers that do not
      // expose webkitLineClamp in computed style but still clamp visually.
      return cs.webkitLineClamp === '3' || el.scrollHeight > el.clientHeight
    })
    expect(isClamped).toBe(true)

    // ── Criterion 2: the expand affordance is visible ────────────────────────
    //
    // ProposalRow renders a button with aria-expanded and text "more down"
    // in the collapsed state (ProposalsPage.tsx ~lines 111-118).
    const expandBtn = page.locator('.mars-card button[aria-expanded]').first()
    await expect(expandBtn).toHaveAttribute('aria-expanded', 'false')
    await expect(expandBtn).toBeVisible()
    await expect(expandBtn).toContainText('more')

    // ── Criterion 3: clicking the affordance reveals the full body text ──────
    //
    // After the click, React re-renders: aria-expanded flips to "true" and
    // the paragraph's class changes from "line-clamp-3" to
    // "whitespace-pre-wrap", removing the CSS clamp and showing the full text.
    await expandBtn.click()

    // aria-expanded reflects the new expanded state.
    await expect(expandBtn).toHaveAttribute('aria-expanded', 'true')

    // The clamped paragraph is gone: its class changed, so the locator no
    // longer matches any element in the DOM.
    await expect(page.locator('.mars-card p.line-clamp-3')).not.toBeVisible()

    // The un-clamped paragraph with the full text is now visible.
    await expect(page.locator('.mars-card p.whitespace-pre-wrap').first()).toBeVisible()
  },
)
