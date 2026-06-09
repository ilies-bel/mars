import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TopStripe } from './TopStripe'

describe('TopStripe – stat labels match their values', () => {
  it('shows the IN PROGRESS count', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} done={5} failed={2} connected={true} />,
    )
    expect(html).toContain('3 IN PROGRESS')
  })

  it('shows the DONE count', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} done={5} failed={2} connected={true} />,
    )
    expect(html).toContain('5 DONE')
  })

  it('shows the FAILED count', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} done={5} failed={2} connected={true} />,
    )
    expect(html).toContain('2 FAILED')
  })

  it('does not show an ACTION QUEUE label (replaced by FAILED)', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} done={0} failed={0} connected={true} />,
    )
    expect(html).not.toContain('ACTION QUEUE')
  })

  it('DONE and FAILED counts are independent — different values render as distinct stats', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={1} done={7} failed={4} connected={true} />,
    )
    expect(html).toContain('7 DONE')
    expect(html).toContain('4 FAILED')
    // The FAILED count (4) must not bleed into the DONE slot
    expect(html).not.toContain('4 DONE')
    // The DONE count (7) must not bleed into the FAILED slot
    expect(html).not.toContain('7 FAILED')
  })
})

describe('TopStripe – connection indicator', () => {
  it('shows "live" when connected', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} done={0} failed={0} connected={true} />,
    )
    expect(html).toContain('>live<')
    expect(html).not.toContain('>offline<')
  })

  it('shows "offline" when disconnected', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} done={0} failed={0} connected={false} />,
    )
    expect(html).toContain('>offline<')
    expect(html).not.toContain('>live<')
  })
})
