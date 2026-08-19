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
      <TopStripe inProgress={3} doneToday={5} failed={2} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-in-progress', 'stat-done')
    expect(section).toContain('>3<')
    expect(section).toContain('IN PROGRESS')
  })

  it('shows the DONE TODAY count in its own section', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} doneToday={5} failed={2} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-done', 'stat-failed')
    expect(section).toContain('>5<')
    expect(section).toContain('DONE TODAY')
  })

  it('shows the FAILED count in its own section', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} doneToday={5} failed={2} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = from(html, 'stat-failed')
    expect(section).toContain('>2<')
    expect(section).toContain('FAILED')
  })

  it('does not show an ACTION QUEUE label (replaced by FAILED)', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).not.toContain('ACTION QUEUE')
  })

  it('DONE TODAY and FAILED counts are independent — different values render as distinct stats', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={1} doneToday={7} failed={4} connected={true} dispatch={RUNNING} daemonDown={false} />,
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
      <TopStripe inProgress={9} doneToday={0} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-in-progress', 'stat-done')
    expect(section).toContain('tabular-nums')
  })

  it('DONE TODAY count span carries tabular-nums', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={9} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-done', 'stat-failed')
    expect(section).toContain('tabular-nums')
  })

  it('FAILED count span carries tabular-nums', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={9} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = from(html, 'stat-failed')
    expect(section).toContain('tabular-nums')
  })
})

describe('TopStripe – connection indicator', () => {
  it('shows "live" when connected', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).toContain('>live<')
    expect(html).not.toContain('>offline<')
  })

  it('shows "offline" when disconnected', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={false} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).toContain('>offline<')
    expect(html).not.toContain('>live<')
  })

  it('live indicator dot pulses when connected', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).toContain('animate-mars-pulse')
  })

  it('live indicator dot does not pulse when disconnected', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={false} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(html).not.toContain('animate-mars-pulse')
  })
})

describe('TopStripe – visual hierarchy (numbers pop from labels)', () => {
  it('IN PROGRESS count uses the running status color to signal active work', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} doneToday={0} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-in-progress', 'stat-done')
    expect(section).toContain('text-status-running')
  })

  it('DONE TODAY count uses success color', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={5} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-done', 'stat-failed')
    expect(section).toContain('text-success')
  })

  it('FAILED count uses error color to draw attention', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={2} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = from(html, 'stat-failed')
    expect(section).toContain('text-error')
  })

  it('IN PROGRESS label is muted so the number stands out', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={3} doneToday={0} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = between(html, 'stat-in-progress', 'stat-done')
    // The label span should carry text-muted-foreground (not the number span which carries text-status-running)
    expect(section).toContain('text-muted-foreground')
  })

  it('FAILED label is muted so the number stands out', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={2} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    const section = from(html, 'stat-failed')
    expect(section).toContain('text-muted-foreground')
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
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={true} dispatch={RUNNING} daemonDown={false} />,
    )
    expect(from(html, 'health-indicator')).toContain('live')
  })

  it('never reads live while dispatch is paused, even with a healthy stream', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={true} dispatch={PAUSED} daemonDown={false} />,
    )
    const section = from(html, 'health-indicator')
    expect(section).toContain('paused')
    expect(section).toContain('signature storm')
    expect(section).not.toContain('>live<')
    // The dot has to stop reading "healthy" too, not just the label — a green
    // pulse next to the word "paused" is the same lie in a different channel.
    expect(section).not.toContain('animate-mars-pulse')
    expect(section).not.toContain('bg-success')
  })

  it('does not paint the offline dot green', () => {
    const html = renderToStaticMarkup(
      <TopStripe inProgress={0} doneToday={0} failed={0} connected={false} dispatch={RUNNING} daemonDown={false} />,
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
