/**
 * Tests for SessionsList component rendering.
 *
 * Verifies that:
 * - A running session renders with a distinct live indicator (animated dot)
 * - Finished sessions render with their outcome badge only (no live indicator)
 * - Empty state shows an explicit message visually distinct from loading/error
 * - Loading (sessions=null) shows a different message from empty
 * - Error state shows an error message, distinct from empty/loading
 */

import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkerSession } from '@/shared/schemas'
import { SessionsList } from './SessionsList'

const makeSession = (overrides: Partial<WorkerSession> = {}): WorkerSession => ({
  id: 'evt-001',
  sessionId: 'sess-abc',
  workerName: 'Coder',
  stepName: 'code',
  workflowInstanceId: 'wf-001',
  outcome: 'completed',
  endedAt: '2026-05-30T10:00:00.000Z',
  durationMs: 5000,
  ...overrides,
})

// ─── Loading state ────────────────────────────────────────────────────────────

describe('SessionsList – loading state (sessions=null)', () => {
  it('shows a loading message', () => {
    const html = renderToStaticMarkup(<SessionsList sessions={null} error={null} />)
    expect(html).toContain('Loading')
  })

  it('does not show the empty-state message', () => {
    const html = renderToStaticMarkup(<SessionsList sessions={null} error={null} />)
    expect(html).not.toContain('No sessions')
    expect(html).not.toContain('idle')
  })
})

// ─── Error state ──────────────────────────────────────────────────────────────

describe('SessionsList – error state', () => {
  it('shows the error message', () => {
    const html = renderToStaticMarkup(
      <SessionsList sessions={null} error="connection refused" />,
    )
    expect(html).toContain('connection refused')
  })

  it('does not show the empty-state or loading messages', () => {
    const html = renderToStaticMarkup(
      <SessionsList sessions={null} error="oops" />,
    )
    expect(html).not.toContain('No sessions')
    expect(html).not.toContain('Loading')
  })
})

// ─── Empty state ──────────────────────────────────────────────────────────────

describe('SessionsList – empty state (sessions=[])', () => {
  it('shows an explicit empty-state message', () => {
    const html = renderToStaticMarkup(<SessionsList sessions={[]} error={null} />)
    expect(html).toContain('No sessions')
  })

  it('does not show the loading message', () => {
    const html = renderToStaticMarkup(<SessionsList sessions={[]} error={null} />)
    expect(html).not.toContain('Loading')
  })

  it('does not show an error message', () => {
    const html = renderToStaticMarkup(<SessionsList sessions={[]} error={null} />)
    expect(html).not.toContain('unavailable')
  })

  it('is visually distinct from the loading state', () => {
    const emptyHtml = renderToStaticMarkup(<SessionsList sessions={[]} error={null} />)
    const loadingHtml = renderToStaticMarkup(<SessionsList sessions={null} error={null} />)
    // The empty state must have a distinguishing CSS class absent from loading.
    expect(emptyHtml).not.toBe(loadingHtml)
    // Empty state carries the data-empty marker; loading does not.
    expect(emptyHtml).toContain('data-empty')
    expect(loadingHtml).not.toContain('data-empty')
  })
})

// ─── Live (running) session ───────────────────────────────────────────────────

describe('SessionsList – running session live indicator', () => {
  it('renders a live indicator for a running session', () => {
    const html = renderToStaticMarkup(
      <SessionsList
        sessions={[makeSession({ outcome: 'running', durationMs: null })]}
        error={null}
      />,
    )
    // A pulsing dot is rendered for the live session.
    expect(html).toContain('animate-pulse')
  })

  it('does not render the live indicator for a completed session', () => {
    const html = renderToStaticMarkup(
      <SessionsList sessions={[makeSession({ outcome: 'completed' })]} error={null} />,
    )
    expect(html).not.toContain('animate-pulse')
  })

  it('does not render the live indicator for a failed session', () => {
    const html = renderToStaticMarkup(
      <SessionsList sessions={[makeSession({ outcome: 'failed' })]} error={null} />,
    )
    expect(html).not.toContain('animate-pulse')
  })

  it('does not render the live indicator for a killed session', () => {
    const html = renderToStaticMarkup(
      <SessionsList sessions={[makeSession({ outcome: 'killed' })]} error={null} />,
    )
    expect(html).not.toContain('animate-pulse')
  })

  it('renders both a live indicator for the running session and a badge for the finished one', () => {
    const sessions = [
      makeSession({ id: 'r1', outcome: 'running', durationMs: null, workflowInstanceId: 'wf-live' }),
      makeSession({ id: 'f1', outcome: 'completed', workflowInstanceId: 'wf-done' }),
    ]
    const html = renderToStaticMarkup(<SessionsList sessions={sessions} error={null} />)
    expect(html).toContain('animate-pulse')
    expect(html).toContain('completed')
  })
})
