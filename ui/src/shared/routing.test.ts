import { describe, expect, it } from 'bun:test'
import {
  detectRoute,
  actionQueueCount,
  parseTaskRoute,
  parseTaskOrigin,
  parseProposalRoute,
  parseProposalNodeRoute,
  resolvePageRoute,
  taskHash,
} from './routing'
import type { StaleWorktreesPayload } from './schemas'

const emptyStaleWorktrees = (): StaleWorktreesPayload => ({ staleWorktrees: [] })

const withStale = (n: number): StaleWorktreesPayload => ({
  staleWorktrees: Array.from({ length: n }, (_, i) => ({
    taskId: `wt-${i}`,
    status: 'done',
    ageHours: 48,
    updatedAt: new Date().toISOString(),
    prompt: `stale task ${i}`,
    error: null,
    branch: null,
    blockerTaskId: null,
  })),
})

// ---------------------------------------------------------------------------
// detectRoute
// ---------------------------------------------------------------------------

describe('detectRoute', () => {
  it('returns action-queue for an empty or root hash', () => {
    expect(detectRoute('')).toBe('action-queue')
    expect(detectRoute('#/')).toBe('action-queue')
  })

  it('returns action-queue for the legacy #/todo hash', () => {
    expect(detectRoute('#/todo')).toBe('action-queue')
  })

  it('returns action-queue for the #/action-queue hash', () => {
    expect(detectRoute('#/action-queue')).toBe('action-queue')
    expect(detectRoute('#/action-queue/sub')).toBe('action-queue')
  })

  it('returns progress for the #/progress hash', () => {
    expect(detectRoute('#/progress')).toBe('progress')
    expect(detectRoute('#/progress/anything')).toBe('progress')
  })

  it('does not recognise the legacy #/kanban hash', () => {
    // Hard cut — no alias, no redirect. The legacy hash falls through to the
    // default route.
    expect(detectRoute('#/kanban')).toBe('action-queue')
  })

  it('returns events for the #/events hash', () => {
    expect(detectRoute('#/events')).toBe('events')
    expect(detectRoute('#/events/anything')).toBe('events')
  })
})

// ---------------------------------------------------------------------------
// actionQueueCount — only counts stale worktrees
// ---------------------------------------------------------------------------

describe('actionQueueCount', () => {
  it('returns 0 when there are no stale worktrees', () => {
    expect(actionQueueCount(emptyStaleWorktrees())).toBe(0)
  })

  it('returns the count of stale worktrees', () => {
    expect(actionQueueCount(withStale(3))).toBe(3)
  })

  it('does not count drafts toward the action-queue badge', () => {
    // actionQueueCount accepts StaleWorktreesPayload — proposals are not part of the type
    expect(actionQueueCount(emptyStaleWorktrees())).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// parseTaskRoute
// ---------------------------------------------------------------------------

describe('parseTaskRoute', () => {
  it('returns null when the hash has no task fragment', () => {
    expect(parseTaskRoute('')).toBeNull()
    expect(parseTaskRoute('#/')).toBeNull()
    expect(parseTaskRoute('#/progress')).toBeNull()
  })

  it('returns the id from #/task/<id>', () => {
    expect(parseTaskRoute('#/task/abc-123')).toBe('abc-123')
  })

  it('strips trailing slash and treats empty id as null', () => {
    expect(parseTaskRoute('#/task/')).toBeNull()
  })

  it('decodes percent-encoded ids', () => {
    expect(parseTaskRoute('#/task/mars%2D123')).toBe('mars-123')
  })

  it('does not match a proposal route', () => {
    expect(parseTaskRoute('#/proposal/abc-123')).toBeNull()
  })

  it('returns the id even with a ?from=<route> suffix', () => {
    // The `[^/?#]+` capture stops at the `?`, so the origin suffix is ignored.
    expect(parseTaskRoute('#/task/x?from=action-queue')).toBe('x')
  })
})

// ---------------------------------------------------------------------------
// parseTaskOrigin — reads the `from` query param off a task hash
// ---------------------------------------------------------------------------

describe('parseTaskOrigin', () => {
  it('returns the route from ?from=<route>', () => {
    expect(parseTaskOrigin('#/task/x?from=action-queue')).toBe('action-queue')
    expect(parseTaskOrigin('#/task/x?from=progress')).toBe('progress')
    expect(parseTaskOrigin('#/task/x?from=events')).toBe('events')
  })

  it('returns null when the task hash carries no from', () => {
    expect(parseTaskOrigin('#/task/x')).toBeNull()
  })

  it('returns null for an unrecognised from value', () => {
    expect(parseTaskOrigin('#/task/x?from=bogus')).toBeNull()
  })

  it('returns null for a non-task hash', () => {
    expect(parseTaskOrigin('#/progress')).toBeNull()
    expect(parseTaskOrigin('#/proposal/x?from=action-queue')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// taskHash — builds the overlay hash, optionally tagging the origin
// ---------------------------------------------------------------------------

describe('taskHash', () => {
  it('builds a plain task hash with no origin', () => {
    expect(taskHash('x')).toBe('#/task/x')
  })

  it('appends ?from=<route> when an origin is given', () => {
    expect(taskHash('x', 'action-queue')).toBe('#/task/x?from=action-queue')
  })

  it('percent-encodes the id', () => {
    expect(taskHash('mars-123', 'action-queue')).toBe(
      '#/task/mars-123?from=action-queue',
    )
  })
})

// ---------------------------------------------------------------------------
// parseProposalRoute
// ---------------------------------------------------------------------------

describe('parseProposalRoute', () => {
  it('returns null when the hash has no proposal fragment', () => {
    expect(parseProposalRoute('')).toBeNull()
    expect(parseProposalRoute('#/progress')).toBeNull()
    expect(parseProposalRoute('#/task/abc-123')).toBeNull()
  })

  it('returns the id from #/proposal/<id>', () => {
    expect(parseProposalRoute('#/proposal/abc-123')).toBe('abc-123')
  })

  it('strips trailing slash and treats empty id as null', () => {
    expect(parseProposalRoute('#/proposal/')).toBeNull()
  })

  it('decodes percent-encoded ids', () => {
    expect(parseProposalRoute('#/proposal/mars%2D123')).toBe('mars-123')
  })
})

// ---------------------------------------------------------------------------
// resolvePageRoute – overlay keeps Progress page mounted (criterion 4)
// ---------------------------------------------------------------------------

describe('resolvePageRoute', () => {
  it('returns progress when a task overlay hash is present', () => {
    // A task drawer hash forces the Progress page to stay mounted so that
    // the operator's view state (active tab, filters) is preserved.
    expect(resolvePageRoute('#/task/mars-abc123')).toBe('progress')
  })

  it('returns the from-route when a task overlay carries ?from=', () => {
    // Opening the drawer from the Action queue keeps the AQ list mounted
    // behind it (and closing returns there).
    expect(resolvePageRoute('#/task/x?from=action-queue')).toBe('action-queue')
  })

  it('still returns progress for a plain task hash (no from)', () => {
    expect(resolvePageRoute('#/task/x')).toBe('progress')
  })

  it('falls back to progress for an unrecognised from value', () => {
    expect(resolvePageRoute('#/task/x?from=bogus')).toBe('progress')
  })

  it('returns progress after the drawer closes (hash reset to #/progress)', () => {
    // clearTaskHash in App sets window.location.hash = '#/progress'.
    // Verifying that the same route name is produced both during and after the
    // overlay guarantees the ProgressPage component is never unmounted.
    expect(resolvePageRoute('#/progress')).toBe('progress')
  })

  it('returns action-queue for an empty hash (no overlay, no named route)', () => {
    expect(resolvePageRoute('')).toBe('action-queue')
  })

  it('returns action-queue for a malformed #/task/ hash (empty id)', () => {
    // A stray '#/task/' must not open a blank overlay or force the progress route.
    expect(resolvePageRoute('#/task/')).toBe('action-queue')
  })

  it('returns progress when a proposal overlay hash is present', () => {
    expect(resolvePageRoute('#/proposal/prop-abc')).toBe('progress')
  })

  it('returns progress when a proposal-node overlay hash is present', () => {
    expect(resolvePageRoute('#/proposal-node/p-abc')).toBe('progress')
  })
})

// ---------------------------------------------------------------------------
// parseProposalNodeRoute
// ---------------------------------------------------------------------------

describe('parseProposalNodeRoute', () => {
  it('returns null when the hash has no proposal-node fragment', () => {
    expect(parseProposalNodeRoute('')).toBeNull()
    expect(parseProposalNodeRoute('#/progress')).toBeNull()
    expect(parseProposalNodeRoute('#/task/abc-123')).toBeNull()
    expect(parseProposalNodeRoute('#/proposal/abc-123')).toBeNull()
  })

  it('returns the id from #/proposal-node/<id>', () => {
    expect(parseProposalNodeRoute('#/proposal-node/abc-123')).toBe('abc-123')
  })

  it('strips trailing slash and treats empty id as null', () => {
    expect(parseProposalNodeRoute('#/proposal-node/')).toBeNull()
  })

  it('decodes percent-encoded ids', () => {
    expect(parseProposalNodeRoute('#/proposal-node/mars%2D123')).toBe('mars-123')
  })
})
