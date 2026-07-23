import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TopStripe } from './TopStripe'

// ---------------------------------------------------------------------------
// Section helpers — extract a region of the rendered HTML bounded by
// data-testid markers so assertions stay scoped to the right stat group.
// ---------------------------------------------------------------------------

function between(html: string, startId: string, endId: string): string {
  const s = html.indexOf(`data-testid="${startId}"`)
  const e = html.indexOf(`data-testid="${endId}"`)
  if (s === -1) return ''
  return e === -1 ? html.slice(s) : html.slice(s, e)
}

function from(html: string, startId: string): string {
  const s = html.indexOf(`data-testid="${startId}"`)
  return s === -1 ? '' : html.slice(s)
}

describe('TopStripe – stat labels match their values', () => {
  it('shows the IN PROGRESS count in its own section', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} doneToday={5} failed={2} connected={true} />,
    )
    const section = between(html, 'stat-in-progress', 'stat-done')
    expect(section).toContain('>3<')
    expect(section).toContain('IN PROGRESS')
  })

  it('shows the DONE TODAY count in its own section', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} doneToday={5} failed={2} connected={true} />,
    )
    const section = between(html, 'stat-done', 'stat-failed')
    expect(section).toContain('>5<')
    expect(section).toContain('DONE TODAY')
  })

  it('shows the FAILED count in its own section', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} doneToday={5} failed={2} connected={true} />,
    )
    const section = from(html, 'stat-failed')
    expect(section).toContain('>2<')
    expect(section).toContain('FAILED')
  })

  it('does not show an ACTION QUEUE label (replaced by FAILED)', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={true} />,
    )
    expect(html).not.toContain('ACTION QUEUE')
  })

  it('DONE TODAY and FAILED counts are independent — different values render as distinct stats', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={1} doneToday={7} failed={4} connected={true} />,
    )
    const doneSection = between(html, 'stat-done', 'stat-failed')
    const failedSection = from(html, 'stat-failed')
    // The DONE count (7) appears in the done section
    expect(doneSection).toContain('>7<')
    // The FAILED count (4) must not bleed into the DONE section
    expect(doneSection).not.toContain('>4<')
    // The FAILED count (4) appears in the failed section
    expect(failedSection).toContain('>4<')
    // The DONE count (7) must not bleed into the FAILED section
    expect(failedSection).not.toContain('>7<')
  })
})

describe('TopStripe – digit jitter prevention', () => {
  it('IN PROGRESS count span carries tabular-nums so width stays stable across values', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={9} doneToday={0} failed={0} connected={true} />,
    )
    const section = between(html, 'stat-in-progress', 'stat-done')
    expect(section).toContain('tabular-nums')
  })

  it('DONE TODAY count span carries tabular-nums', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={9} failed={0} connected={true} />,
    )
    const section = between(html, 'stat-done', 'stat-failed')
    expect(section).toContain('tabular-nums')
  })

  it('FAILED count span carries tabular-nums', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={9} connected={true} />,
    )
    const section = from(html, 'stat-failed')
    expect(section).toContain('tabular-nums')
  })
})

describe('TopStripe – connection indicator', () => {
  it('shows "live" when connected', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={true} />,
    )
    expect(html).toContain('>live<')
    expect(html).not.toContain('>offline<')
  })

  it('shows "offline" when disconnected', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={false} />,
    )
    expect(html).toContain('>offline<')
    expect(html).not.toContain('>live<')
  })
})
