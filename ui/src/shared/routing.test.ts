import { describe, expect, it } from 'bun:test'
import {
  detectRoute,
  isKnownRoute,
  actionQueueCount,
  pageTitle,
  parseOverlayOrigin,
  parseTaskRoute,
  parseTaskOrigin,
  parseTaskStep,
  parseProposalRoute,
  parseProposalNodeRoute,
  parseProposalOrigin,
  parsePrimitiveRoute,
  parseReleaseNotesRoute,
  parseStudioRoute,
  primitiveHash,
  proposalNodeHash,
  releaseNotesHash,
  resolvePageRoute,
  studioHash,
  taskHash,
  proposalHash,
} from './routing'
import { PRIMITIVE_NAMES } from '@/entities/primitive/types'
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
  it('returns chat for an empty or root hash (chat is the default landing page)', () => {
    expect(detectRoute('')).toBe('chat')
    expect(detectRoute('#/')).toBe('chat')
    expect(detectRoute('#')).toBe('chat')
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

  it('returns kpi for the bare #/kpi index route', () => {
    // Nav highlight and page routing both depend on detectRoute — the KPI index
    // page (#/kpi) must light up the KPIS nav link, not the Action Queue.
    expect(detectRoute('#/kpi')).toBe('kpi')
  })

  it('returns kpi for a #/kpi/<key> detail route', () => {
    expect(detectRoute('#/kpi/failure_rate')).toBe('kpi')
    expect(detectRoute('#/kpi/cost_per_arc')).toBe('kpi')
  })
})

// ---------------------------------------------------------------------------
// isKnownRoute — gate for unknown-hash redirect in App
// ---------------------------------------------------------------------------

describe('isKnownRoute', () => {
  it('returns true for the empty / root hash (Action Queue default)', () => {
    expect(isKnownRoute('')).toBe(true)
    expect(isKnownRoute('#')).toBe(true)
    expect(isKnownRoute('#/')).toBe(true)
  })

  it('returns true for named page routes', () => {
    expect(isKnownRoute('#/action-queue')).toBe(true)
    expect(isKnownRoute('#/action-queue/sub')).toBe(true)
    expect(isKnownRoute('#/progress')).toBe(true)
    expect(isKnownRoute('#/events')).toBe(true)
    expect(isKnownRoute('#/kpi')).toBe(true)
    expect(isKnownRoute('#/kpi/cost_per_arc')).toBe(true)
  })

  it('returns true for overlay routes', () => {
    expect(isKnownRoute('#/task/mars-123')).toBe(true)
    expect(isKnownRoute('#/proposal/prop-1')).toBe(true)
    expect(isKnownRoute('#/proposal-node/p-1')).toBe(true)
    expect(isKnownRoute('#/release-notes')).toBe(true)
  })

  it('returns false for completely unknown hashes', () => {
    expect(isKnownRoute('#/bogus')).toBe(false)
    expect(isKnownRoute('#/foo-bar')).toBe(false)
    expect(isKnownRoute('#/kpis')).toBe(false)
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

  it('appends &step=<name> when a step is given alongside from', () => {
    expect(taskHash('x', 'events', 'code')).toBe('#/task/x?from=events&step=code')
  })

  it('appends step= without from when from is omitted but step is given', () => {
    expect(taskHash('x', undefined, 'verify')).toBe('#/task/x?step=verify')
  })

  it('percent-encodes the step name', () => {
    expect(taskHash('x', 'events', 'my step')).toBe(
      '#/task/x?from=events&step=my%20step',
    )
  })
})

// ---------------------------------------------------------------------------
// parseTaskStep — reads the optional step= query param from a task hash
// ---------------------------------------------------------------------------

describe('parseTaskStep', () => {
  it('returns null when the hash has no task fragment', () => {
    expect(parseTaskStep('#/progress')).toBeNull()
    expect(parseTaskStep('')).toBeNull()
  })

  it('returns null when the task hash has no step param', () => {
    expect(parseTaskStep('#/task/x')).toBeNull()
    expect(parseTaskStep('#/task/x?from=events')).toBeNull()
  })

  it('returns the step name when present', () => {
    expect(parseTaskStep('#/task/x?from=events&step=code')).toBe('code')
  })

  it('returns the step name when step is the only query param', () => {
    expect(parseTaskStep('#/task/x?step=verify')).toBe('verify')
  })

  it('decodes percent-encoded step names', () => {
    expect(parseTaskStep('#/task/x?step=my%20step')).toBe('my step')
  })

  it('returns null for an empty step value', () => {
    expect(parseTaskStep('#/task/x?step=')).toBeNull()
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
// proposalHash — builds the overlay hash, optionally tagging the origin
// ---------------------------------------------------------------------------

describe('proposalHash', () => {
  it('builds a plain proposal hash with no origin', () => {
    expect(proposalHash('x')).toBe('#/proposal/x')
  })

  it('appends ?from=<route> when an origin is given', () => {
    expect(proposalHash('x', 'action-queue')).toBe('#/proposal/x?from=action-queue')
  })

  it('percent-encodes the id', () => {
    expect(proposalHash('mars-123')).toBe('#/proposal/mars-123')
  })

  it('appends ?from=progress when progress is given', () => {
    expect(proposalHash('abc', 'progress')).toBe('#/proposal/abc?from=progress')
  })
})

// ---------------------------------------------------------------------------
// parseProposalOrigin — reads the `from` query param off a proposal hash
// ---------------------------------------------------------------------------

describe('parseProposalOrigin', () => {
  it('returns the route from ?from=<route>', () => {
    expect(parseProposalOrigin('#/proposal/x?from=action-queue')).toBe('action-queue')
    expect(parseProposalOrigin('#/proposal/x?from=progress')).toBe('progress')
    expect(parseProposalOrigin('#/proposal/x?from=events')).toBe('events')
  })

  it('returns null when the proposal hash carries no from', () => {
    expect(parseProposalOrigin('#/proposal/x')).toBeNull()
  })

  it('returns null for an unrecognised from value', () => {
    expect(parseProposalOrigin('#/proposal/x?from=bogus')).toBeNull()
  })

  it('returns null for a non-proposal hash', () => {
    expect(parseProposalOrigin('#/progress')).toBeNull()
    expect(parseProposalOrigin('#/task/x?from=action-queue')).toBeNull()
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

  it('returns chat for an empty hash (chat is the default landing page)', () => {
    expect(resolvePageRoute('')).toBe('chat')
  })

  it('returns action-queue for a malformed #/task/ hash (empty id)', () => {
    // A stray '#/task/' must not open a blank overlay or force the progress route.
    expect(resolvePageRoute('#/task/')).toBe('action-queue')
  })

  it('returns progress when a proposal overlay hash is present (no from)', () => {
    expect(resolvePageRoute('#/proposal/prop-abc')).toBe('progress')
  })

  it('returns the from-route when a proposal overlay carries ?from=action-queue', () => {
    // Opening the proposal drawer from the Action Queue should keep AQ mounted
    // behind it and closing returns there — matching task drawer behaviour.
    expect(resolvePageRoute('#/proposal/x?from=action-queue')).toBe('action-queue')
  })

  it('falls back to progress for a proposal with an unrecognised from value', () => {
    expect(resolvePageRoute('#/proposal/x?from=bogus')).toBe('progress')
  })

  it('returns progress when a proposal-node overlay hash is present', () => {
    expect(resolvePageRoute('#/proposal-node/p-abc')).toBe('progress')
  })

  it('returns progress when the release-notes overlay hash is present', () => {
    expect(resolvePageRoute('#/release-notes')).toBe('progress')
  })

  it('returns kpi for the bare #/kpi index route', () => {
    // App renders KpiIndexPage when route === "kpi" && kpiKey === null.
    // resolvePageRoute must return "kpi" (not "action-queue") for bare #/kpi
    // so the correct page and the correct nav highlight are rendered.
    expect(resolvePageRoute('#/kpi')).toBe('kpi')
  })
})

// ---------------------------------------------------------------------------
// releaseNotesHash + parseReleaseNotesRoute
// ---------------------------------------------------------------------------

describe('releaseNotesHash', () => {
  it('returns the constant release-notes hash', () => {
    expect(releaseNotesHash()).toBe('#/release-notes')
  })
})

describe('parseReleaseNotesRoute', () => {
  it('returns true for the exact #/release-notes hash', () => {
    expect(parseReleaseNotesRoute('#/release-notes')).toBe(true)
  })

  it('returns false for other hashes', () => {
    expect(parseReleaseNotesRoute('#/progress')).toBe(false)
    expect(parseReleaseNotesRoute('')).toBe(false)
    expect(parseReleaseNotesRoute('#/task/abc')).toBe(false)
    expect(parseReleaseNotesRoute('#/release-notes/extra')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pageTitle — document.title text per route
// ---------------------------------------------------------------------------

describe('pageTitle', () => {
  it('returns "mars — action queue" for the action-queue route with no items', () => {
    expect(pageTitle('action-queue', 0)).toBe('mars — action queue')
  })

  it('returns "mars — action queue (N)" when there are N action queue items', () => {
    expect(pageTitle('action-queue', 3)).toBe('mars — action queue (3)')
    expect(pageTitle('action-queue', 12)).toBe('mars — action queue (12)')
  })

  it('defaults aqCount to 0 when omitted', () => {
    expect(pageTitle('action-queue')).toBe('mars — action queue')
  })

  it('returns "mars — progress" for the progress route', () => {
    expect(pageTitle('progress')).toBe('mars — progress')
  })

  it('returns "mars — events" for the events route', () => {
    expect(pageTitle('events')).toBe('mars — events')
  })

  it('returns "mars — kpis" for the kpi route', () => {
    expect(pageTitle('kpi')).toBe('mars — kpis')
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

// ---------------------------------------------------------------------------
// Studio route — parseStudioRoute / studioHash
// ---------------------------------------------------------------------------

describe('parseStudioRoute', () => {
  it('returns null when the hash has no studio fragment', () => {
    expect(parseStudioRoute('')).toBeNull()
    expect(parseStudioRoute('#/progress')).toBeNull()
    expect(parseStudioRoute('#/task/abc-123')).toBeNull()
    expect(parseStudioRoute('#/studio')).toBeNull()
  })

  it('returns the task id from #/studio/<taskId>', () => {
    expect(parseStudioRoute('#/studio/mars-abc123')).toBe('mars-abc123')
  })

  it('strips trailing slash and treats empty id as null', () => {
    expect(parseStudioRoute('#/studio/')).toBeNull()
    expect(parseStudioRoute('#/studio/abc/extra')).toBe('abc')
  })

  it('decodes percent-encoded ids', () => {
    expect(parseStudioRoute('#/studio/mars%2D123')).toBe('mars-123')
  })
})

describe('studioHash', () => {
  it('builds the #/studio/<taskId> hash', () => {
    expect(studioHash('mars-abc123')).toBe('#/studio/mars-abc123')
  })

  it('encodes ids that need escaping', () => {
    expect(studioHash('a b')).toBe('#/studio/a%20b')
  })

  it('round-trips through parseStudioRoute', () => {
    expect(parseStudioRoute(studioHash('mars-xyz'))).toBe('mars-xyz')
  })
})

describe('studio route integration', () => {
  it('detectRoute resolves #/studio/<id> to studio', () => {
    expect(detectRoute('#/studio/mars-abc')).toBe('studio')
  })

  it('detectRoute falls back to action-queue for a bare #/studio/', () => {
    expect(detectRoute('#/studio/')).toBe('action-queue')
  })

  it('isKnownRoute accepts #/studio/<id> but rejects a bare #/studio/', () => {
    expect(isKnownRoute('#/studio/mars-abc')).toBe(true)
    expect(isKnownRoute('#/studio/')).toBe(false)
    expect(isKnownRoute('#/studio')).toBe(false)
  })

  it('resolvePageRoute resolves #/studio/<id> to studio', () => {
    expect(resolvePageRoute('#/studio/mars-abc')).toBe('studio')
  })

  it('pageTitle returns "mars — studio" for the studio route', () => {
    expect(pageTitle('studio')).toBe('mars — studio')
  })
})

// ---------------------------------------------------------------------------
// parsePrimitiveRoute / primitiveHash
// ---------------------------------------------------------------------------

describe('parsePrimitiveRoute', () => {
  it('returns null when the hash has no primitive fragment', () => {
    expect(parsePrimitiveRoute('')).toBeNull()
    expect(parsePrimitiveRoute('#/progress')).toBeNull()
    expect(parsePrimitiveRoute('#/task/abc-123')).toBeNull()
    expect(parsePrimitiveRoute('#/primitive')).toBeNull()
    expect(parsePrimitiveRoute('#/primitive/')).toBeNull()
  })

  it('returns each of the six known primitive names', () => {
    for (const name of PRIMITIVE_NAMES) {
      expect(parsePrimitiveRoute(`#/primitive/${name}`)).toBe(name)
    }
  })

  it('normalises unknown names to null', () => {
    expect(parsePrimitiveRoute('#/primitive/typo')).toBeNull()
    expect(parsePrimitiveRoute('#/primitive/setupworktree')).toBeNull()
  })
})

describe('primitiveHash', () => {
  it('builds the #/primitive/<name> hash', () => {
    expect(primitiveHash('runAgent')).toBe('#/primitive/runAgent')
  })

  it('round-trips through parsePrimitiveRoute', () => {
    expect(parsePrimitiveRoute(primitiveHash('awaitHuman'))).toBe('awaitHuman')
  })
})

describe('primitive route integration', () => {
  it('isKnownRoute accepts known names and rejects unknown ones', () => {
    expect(isKnownRoute('#/primitive/verify')).toBe(true)
    expect(isKnownRoute('#/primitive/typo')).toBe(false)
    expect(isKnownRoute('#/primitive/')).toBe(false)
  })

  it('resolvePageRoute keeps Progress mounted beneath the primitive overlay', () => {
    expect(resolvePageRoute('#/primitive/merge')).toBe('progress')
  })

  it('detectRoute leaves the underlying page resolution to resolvePageRoute', () => {
    // A primitive hash is an overlay, not a page route — detectRoute's
    // default applies and resolvePageRoute overrides it to progress.
    expect(detectRoute('#/primitive/verify')).toBe('action-queue')
    expect(resolvePageRoute('#/primitive/verify')).toBe('progress')
  })
})

// ---------------------------------------------------------------------------
// parseOverlayOrigin — generic ?from= for any overlay hash
// ---------------------------------------------------------------------------

describe('parseOverlayOrigin', () => {
  it('reads from= from a proposal-node hash', () => {
    expect(parseOverlayOrigin('#/proposal-node/x?from=action-queue')).toBe('action-queue')
    expect(parseOverlayOrigin('#/proposal-node/x?from=events')).toBe('events')
  })

  it('reads from= from a primitive hash', () => {
    expect(parseOverlayOrigin('#/primitive/verify?from=progress')).toBe('progress')
  })

  it('returns null when no from= is present', () => {
    expect(parseOverlayOrigin('#/proposal-node/x')).toBeNull()
    expect(parseOverlayOrigin('#/primitive/verify')).toBeNull()
  })

  it('returns null for unrecognised from values', () => {
    expect(parseOverlayOrigin('#/proposal-node/x?from=bogus')).toBeNull()
  })

  it('returns null when hash has no query string', () => {
    expect(parseOverlayOrigin('#/progress')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// proposalNodeHash — builds #/proposal-node/<id> with optional ?from=
// ---------------------------------------------------------------------------

describe('proposalNodeHash', () => {
  it('builds a plain proposal-node hash with no origin', () => {
    expect(proposalNodeHash('x')).toBe('#/proposal-node/x')
  })

  it('appends ?from=<route> when an origin is given', () => {
    expect(proposalNodeHash('x', 'action-queue')).toBe('#/proposal-node/x?from=action-queue')
  })
})

// ---------------------------------------------------------------------------
// resolvePageRoute — overlay ?from= support for proposal-node and primitive
// ---------------------------------------------------------------------------

describe('resolvePageRoute — overlay from support', () => {
  it('proposal-node with ?from=events keeps events mounted', () => {
    expect(resolvePageRoute('#/proposal-node/x?from=events')).toBe('events')
  })

  it('proposal-node with ?from=action-queue keeps AQ mounted', () => {
    expect(resolvePageRoute('#/proposal-node/x?from=action-queue')).toBe('action-queue')
  })

  it('primitive with ?from=events keeps events mounted', () => {
    expect(resolvePageRoute('#/primitive/verify?from=events')).toBe('events')
  })

  it('primitive with no ?from= defaults to progress', () => {
    expect(resolvePageRoute('#/primitive/verify')).toBe('progress')
  })
})
