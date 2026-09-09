/**
 * Drift gate for the shared page measure (PAGE_MEASURE).
 *
 * A list page has three things that must share a left edge: the h1, the
 * toolbar, and the cards. Measured at 1512px before this was shared, Draft
 * proposals put them at 248, 240 and 344 — three different edges on one page,
 * because the card list carried `mx-auto max-w-[1080px]` and centred itself
 * inside the pane instead of aligning to the gutter its header used.
 *
 * Needs You had exactly the same defect and was fixed in isolation a round
 * earlier, which is how a fix stays local instead of becoming a rule. This
 * gate makes it a rule: neither page may reintroduce a private measure or a
 * self-centring list, and a third list page has one obvious thing to reach
 * for.
 *
 * The check is on source text rather than rendered output because the defect
 * is invisible at the widths a jsdom test runs at — a centred column and an
 * aligned one land on the same x until the viewport exceeds the cap.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PAGE_MEASURE } from '@/widgets/primitives/DensityPrimitives'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (file: string): string => readFileSync(path.join(here, file), 'utf8')

const LIST_PAGES = ['TriagePage.tsx', 'ProposalsPage.tsx'] as const

describe('PAGE_MEASURE', () => {
  it('is a width cap and nothing else', () => {
    // It deliberately carries no `px-*`: the gutter belongs to PageBody or to
    // the page's own scroll container. A measure that also padded would double
    // whichever gutter it was nested inside.
    expect(PAGE_MEASURE).toBe('max-w-[1080px]')
    expect(PAGE_MEASURE).not.toMatch(/\bp[xlrtby]?-/)
    expect(PAGE_MEASURE).not.toContain('mx-auto')
  })
})

describe.each(LIST_PAGES)('%s — aligns to the shared measure', (file) => {
  const source = read(file)

  it('uses PAGE_MEASURE for its content column', () => {
    expect(source).toContain('PAGE_MEASURE')
  })

  it('does not cap a full-width column with a private number', () => {
    // Scoped to `w-full` containers — the page COLUMN. A local `max-w-[420px]`
    // on a centred paragraph is a different thing and stays allowed; blanket-
    // banning max-w would have flagged the empty state's own sentence width.
    const columnCaps = [...source.matchAll(/className=[^\n]*w-full[^\n]*/g)]
      .map((m) => m[0])
      .filter((line) => /max-w-\[\d+px\]/.test(line))
    expect(columnCaps).toEqual([])
  })

  it('never centres its content column inside the pane', () => {
    // `mx-auto` is what broke the alignment: it centres against the PANE,
    // which has nothing to do with where the header's gutter put the h1.
    expect(source).not.toContain('mx-auto flex w-full')
  })

  it('declares the page gutter on the scroll container, once', () => {
    // px-6 is the number PageHeader uses. A branch that declared its own
    // padding would put the empty state and the list on different edges.
    expect(source).toMatch(/overflow-y-auto px-6/)
  })
})
