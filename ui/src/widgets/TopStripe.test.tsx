import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TopStripe } from './TopStripe'
import type { DispatchPauseState } from '@/shared/api'

const RUNNING: DispatchPauseState = { paused: false, reason: null, since: null, detail: null }
const PAUSED: DispatchPauseState = {
  paused: true,
  reason: 'storm',
  since: '2026-08-19T10:00:00.000Z',
  detail: 'signature storm: code:context-exhausted/unclassified x3',
}

// The IN PROGRESS and FAILED stats used to live here too, with their own
// colour/tabular-nums/label tests. They were removed from the component, not
// from the tests by accident: the board's own column headers already state
// both, and stated them DIFFERENTLY — the header read "18 Failed" (failedOpen,
// which is `status='failed' AND fix_for_task_id IS NULL`) while the FAILED
// column 130px below read "19" (every card it renders). One of those tests
// even pinned the discrepancy: "FAILED stat counts per-origin — a failed
// recovery does not inflate the count". The columns are now the single source.

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

  it('shows the done count, and says it is a rolling 24h window', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={5} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = from(html, 'stat-done')
    expect(section).toContain('>5<')
    // "Done Today" implied a calendar day. The query is
    // `updated_at >= now() - interval '1 day'`, so at 09:00 most of what it
    // counts is yesterday's.
    expect(section).toContain('last 24h')
    expect(html).not.toContain('Done Today')
  })

  it('is the only count in the header', () => {
    // The columns below carry In Progress / Blocked / Failed and can be
    // checked against the cards they sit above; the header cannot. Two
    // sources for one number is how "18 Failed" ended up over a column
    // reading 19.
    const html = renderToStaticMarkup(
      <TopStripe doneToday={5} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).not.toContain('In Progress')
    expect(html).not.toContain('stat-failed')
    expect(html).not.toContain('stat-in-progress')
  })



})

describe('TopStripe – digit jitter prevention', () => {

  it('DONE TODAY count span carries tabular-nums', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={9} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-done', 'stat-failed')
    expect(section).toContain('tabular-nums')
  })

})

describe('TopStripe – connection indicator', () => {
  it('shows "live" when connected', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).toContain('>live<')
    expect(html).not.toContain('>offline<')
  })

  it('shows "offline" when disconnected', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={0} connected={false} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).toContain('>offline<')
    expect(html).not.toContain('>live<')
  })

  it('live indicator dot pulses when connected', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).toContain('animate-mars-pulse')
  })

  it('live indicator dot does not pulse when disconnected', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={0} connected={false} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).not.toContain('animate-mars-pulse')
  })
})

describe('TopStripe – visual hierarchy (numbers pop from labels)', () => {

  it('DONE TODAY count uses status-done color when count is non-zero', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={5} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-done', 'stat-failed')
    expect(section).toContain('text-status-done')
  })



})

// ---------------------------------------------------------------------------
// Health indicator. `connected` is only the SSE socket: a paused daemon is
// perfectly connected and perfectly idle, and a green "live" for it reads as
// "healthy, nothing to do" when the truth is "frozen, nothing will happen".
// ---------------------------------------------------------------------------

describe('TopStripe – health indicator', () => {
  it('reads live when dispatch is running and the stream is connected', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(from(html, 'health-indicator')).toContain('live')
  })

  it('never reads live while dispatch is paused, even with a healthy stream', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={0} connected={true} dispatch={PAUSED} daemonDown={false} />,
    )
    const section = from(html, 'health-indicator')
    expect(section).toContain('paused')
    expect(section).toContain('signature storm')
    expect(section).not.toContain('>live<')
  })

  it('does not paint the offline dot green', () => {
    const html = renderToStaticMarkup(
      <TopStripe doneToday={0} connected={false} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = from(html, 'health-indicator')
    expect(section).toContain('offline')
    expect(section).not.toContain('bg-success')
  })
})

describe('TopStripe – daemon reachability outranks everything else', () => {
  it('says "daemon down" rather than "live" when the daemon is not running', () => {
    // The SSE socket is served by the mars-ui server, so `connected` stays true
    // while the daemon is dead. Showing a pulsing green "live" there put a
    // healthy indicator directly under the unreachable banner.
    const html = renderToStaticMarkup(
      <TopStripe
        inProgress={0}
        doneToday={0}
        failed={0}
        connected={true}
        dispatch={RUNNING}
        daemonDown={true}
      />,
    )
    const dot = from(html, 'health-indicator')
    expect(dot).toContain('daemon down')
    expect(dot).not.toContain('>live<')
  })

  it('outranks a pause — a stopped daemon is not merely paused', () => {
    const html = renderToStaticMarkup(
      <TopStripe
        inProgress={0}
        doneToday={0}
        failed={0}
        connected={false}
        dispatch={PAUSED}
        daemonDown={true}
      />,
    )
    const dot = from(html, 'health-indicator')
    expect(dot).toContain('daemon down')
    expect(dot).not.toContain('paused')
  })

  it('still reports the pause when the daemon is up', () => {
    const html = renderToStaticMarkup(
      <TopStripe
        inProgress={0}
        doneToday={0}
        failed={0}
        connected={true}
        dispatch={PAUSED}
        daemonDown={false}
      />,
    )
    expect(from(html, 'health-indicator')).toContain('paused')
  })
})
