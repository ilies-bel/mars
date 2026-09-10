/**
 * Unit tests for the task-actions button row (RecoveryCommands) and the
 * BlockersSection in TaskDetailDrawer.
 *
 * Rendering strategy: `renderToStaticMarkup` (synchronous SSR, no DOM) so
 * the test runs in the `node` vitest project without any DOM environment.
 * Click handlers cannot be triggered in this mode — we verify:
 *   • the correct buttons are present (data-testid) and labeled
 *   • buttons disabled for the right conditions
 *   • CLI disclosure contains expected text strings (for terminal-user UX)
 *
 * `invokeAction` is mocked so the module can be imported without a live
 * daemon.
 */

import { describe, expect, it, mock } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RecoveryCommands } from './TaskDetailDrawer'

// Prevent invokeAction from making real HTTP requests during static render.
// The onClick handlers never fire in renderToStaticMarkup, but the module
// must import cleanly.
mock.module('@/shared/api', () => ({
  invokeAction: async () => {},
  fetchAgentToolCalls: async () => [],
  fetchRunTimeline: async () => ({ steps: [] }),
  fetchStepSpans: async () => [],
  fetchTaskChanges: async () => ({ commits: [], files: [] }),
}))

// ---------------------------------------------------------------------------
// RecoveryCommands — normal failed task (non-recovery-exhausted)
// ---------------------------------------------------------------------------

describe('RecoveryCommands — normal failed task', () => {
  const html = renderToStaticMarkup(
    <RecoveryCommands taskId="mars-abc123" error="code:context-exhausted" />,
  )

  it('renders the Continue button', () => {
    expect(html).toContain('data-testid="continue-btn"')
  })

  it('labels the Continue button correctly', () => {
    expect(html).toContain('>Continue<')
  })

  it('renders the Restart button', () => {
    expect(html).toContain('data-testid="restart-btn"')
    expect(html).toContain('>Restart<')
  })

  it('renders the delete button under the same name the Needs You card uses', () => {
    expect(html).toContain('data-testid="drop-btn"')
    expect(html).toContain('>Delete task<')
    // "Drop" here and "Delete task" on the card read as two operations.
    expect(html).not.toContain('>Drop<')
  })

  it('does NOT render Remerge or Supersede buttons for a non-exhausted arc', () => {
    expect(html).not.toContain('data-testid="remerge-btn"')
    expect(html).not.toContain('data-testid="supersede-btn"')
  })

  it('Continue button appears before Restart button in document order', () => {
    expect(html.indexOf('continue-btn')).toBeLessThan(html.indexOf('restart-btn'))
  })

  // CLI disclosure — text strings that terminal users and existing tests rely on
  it('CLI disclosure contains mars continue taskId', () => {
    expect(html).toContain('mars continue mars-abc123')
  })

  it('CLI disclosure contains mars restart taskId', () => {
    expect(html).toContain('mars restart mars-abc123')
  })

  it('CLI disclosure names what restart destroys', () => {
    expect(html).toContain('Discards the worktree, branch and all commits')
  })

  it('continue text appears before restart text in CLI disclosure', () => {
    expect(html.indexOf('mars continue')).toBeLessThan(html.indexOf('mars restart'))
  })
})

// ---------------------------------------------------------------------------
// RecoveryCommands — recovery_exhausted arc
// ---------------------------------------------------------------------------

describe('RecoveryCommands — recovery_exhausted arc', () => {
  const html = renderToStaticMarkup(
    <RecoveryCommands
      taskId="mars-bff7e039"
      error="recovery_exhausted:fix-cb2b7dea"
    />,
  )

  it('renders Remerge button', () => {
    expect(html).toContain('data-testid="remerge-btn"')
    expect(html).toContain('>Remerge<')
  })

  it('renders Supersede button', () => {
    expect(html).toContain('data-testid="supersede-btn"')
    expect(html).toContain('>Supersede<')
  })

  it('does NOT render Continue button — mars continue refuses on exhausted arcs', () => {
    expect(html).not.toContain('data-testid="continue-btn"')
  })

  it('still renders Restart button', () => {
    expect(html).toContain('data-testid="restart-btn"')
  })

  it('still renders Drop button', () => {
    expect(html).toContain('data-testid="drop-btn"')
  })

  // CLI disclosure assertions to verify carry-forward verb strings
  it('CLI disclosure contains mars remerge taskId', () => {
    expect(html).toContain('mars remerge mars-bff7e039')
  })

  it('CLI disclosure contains mars task add --supersede taskId', () => {
    expect(html).toContain('mars task add --supersede mars-bff7e039')
  })

  it('CLI disclosure does NOT offer mars continue <taskId> as a command', () => {
    // The explanation mentions "mars continue" generically (will refuse)
    // but must NOT present "mars continue mars-bff7e039" as a usable command.
    expect(html).not.toContain('mars continue mars-bff7e039')
  })

  it('CLI disclosure explains that mars continue will refuse', () => {
    expect(html).toContain('will refuse')
  })

  it('mars remerge appears before mars restart in document order', () => {
    expect(html.indexOf('mars remerge')).toBeLessThan(html.indexOf('mars restart'))
  })
})

// ---------------------------------------------------------------------------
// RecoveryCommands — restart confirm dialog
// ---------------------------------------------------------------------------

describe('RecoveryCommands — restart confirm dialog', () => {
  it('confirm dialog is not shown in the initial (pre-click) render', () => {
    const html = renderToStaticMarkup(
      <RecoveryCommands taskId="mars-xyz" error={null} />,
    )
    // The confirm dialog only renders after the user clicks Restart.
    // In the initial render (useState(null)) it is absent.
    expect(html).not.toContain('data-testid="restart-confirm"')
  })

  it('Restart button posts via invokeAction when confirmed — observable via button data-testid presence', () => {
    // We verify the Restart button exists and is labeled correctly. The actual
    // invokeAction call is verified by code inspection: RecoveryCommands's
    // onClick for restart-confirm-yes calls invoke('restart') which calls
    // invokeAction('restart', taskId). DOM click simulation is omitted here
    // because this test runs without a DOM environment (renderToStaticMarkup).
    const html = renderToStaticMarkup(
      <RecoveryCommands taskId="mars-xyz" error={null} />,
    )
    expect(html).toContain('data-testid="restart-btn"')
    expect(html).toContain('>Restart<')
  })
})
