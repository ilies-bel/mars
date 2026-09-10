/**
 * The bug these exist for: the top stripe painted its paused dot with
 * `bg-warning`, which is not a utility in this theme — the token is
 * `--color-warn`. Tailwind emitted no rule, so the dot was fully transparent
 * in the one state where its colour carries information. Nothing failed:
 * the class was present in the markup, and jsdom has no stylesheet to
 * contradict it.
 *
 * A unit test cannot resolve a Tailwind class, so it checks the next best
 * thing — that every tone this module can produce comes from a closed set of
 * tokens known to exist. A typo becomes a failure instead of an invisible dot.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConnectionStatus, connectionCue } from './ConnectionStatus'

/** Tokens defined in styles/index.css as --color-*. */
const REAL_TONES = new Set(['bg-error', 'bg-warn', 'bg-success', 'bg-muted-foreground'])

const STATES = [
  { connected: true, paused: false },
  { connected: false, paused: false },
  { connected: true, paused: true, pauseLabel: 'quota' },
  { connected: false, paused: true, pauseLabel: 'storm' },
  { connected: true, paused: false, daemonDown: true },
  { connected: true, paused: true, pauseLabel: 'operator', daemonDown: true },
]

describe('connectionCue', () => {
  it('only ever names a colour token that exists', () => {
    for (const state of STATES) {
      const base = connectionCue(state).tone.split(' ')[0]
      expect(REAL_TONES.has(base), `${JSON.stringify(state)} → ${base}`).toBe(true)
    }
  })

  it('always produces a label and a title', () => {
    for (const state of STATES) {
      const cue = connectionCue(state)
      expect(cue.label.length).toBeGreaterThan(0)
      expect(cue.title.length).toBeGreaterThan(0)
    }
  })

  it('ranks a dead daemon above a pause above a dropped socket', () => {
    expect(connectionCue({ connected: false, paused: true, daemonDown: true }).label).toBe(
      'Daemon down',
    )
    expect(connectionCue({ connected: false, paused: true, pauseLabel: 'quota' }).label).toBe(
      'Paused · quota',
    )
    expect(connectionCue({ connected: false, paused: false }).label).toBe('Offline')
    expect(connectionCue({ connected: true, paused: false }).label).toBe('Live')
  })

  it('names a pause even when the reason is missing', () => {
    expect(connectionCue({ connected: true, paused: true, pauseLabel: null }).label).toBe('Paused')
  })

  it('carries no text glyph — the dot is the tone cue', () => {
    const html = renderToStaticMarkup(
      <ConnectionStatus connected paused pauseLabel="operator" />,
    )
    expect(html).not.toContain('⏸')
    expect(html).toContain('Paused · operator')
  })
})
