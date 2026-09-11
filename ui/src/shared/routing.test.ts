import { describe, expect, it } from 'bun:test'
import {
  parseTriageKind,
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
  safeDecode,
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
  it('returns triage for an empty or root hash (triage is the default landing page)', () => {
    expect(detectRoute('')).toBe('triage')
    expect(detectRoute('#/')).toBe('triage')
    expect(detectRoute('#')).toBe('triage')
  })

  it('returns triage for the #/triage hash', () => {
    expect(detectRoute('#/triage')).toBe('triage')
    expect(detectRoute('#/triage/anything')).toBe('triage')
  })

  it('returns chat for the legacy #/todo hash', () => {
    expect(detectRoute('#/todo')).toBe('chat')
  })

  it('returns chat for the legacy #/action-queue hash', () => {
    expect(detectRoute('#/action-queue')).toBe('chat')
    expect(detectRoute('#/action-queue/sub')).toBe('chat')
  })

  it('returns progress for the #/progress hash', () => {
    expect(detectRoute('#/progress')).toBe('progress')
    expect(detectRoute('#/progress/anything')).toBe('progress')
  })

  it('does not recognise the legacy #/kanban hash', () => {
    // Hard cut — no alias, no redirect. The legacy hash falls through to the
    // default route.
    expect(detectRoute('#/kanban')).toBe('chat')
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

  it('returns steward for the #/steward hash', () => {
    expect(detectRoute('#/steward')).toBe('steward')
  })

  it('returns control for the #/control hash', () => {
    expect(detectRoute('#/control')).toBe('control')
  })

  it('returns proposals for the #/proposals hash', () => {
    expect(detectRoute('#/proposals')).toBe('proposals')
  })
})

// ---------------------------------------------------------------------------
// isKnownRoute — gate for unknown-hash redirect in App
// ---------------------------------------------------------------------------

describe('isKnownRoute', () => {
  it('returns true for the empty / root hash (Triage default)', () => {
    expect(isKnownRoute('')).toBe(true)
    expect(isKnownRoute('#')).toBe(true)
    expect(isKnownRoute('#/')).toBe(true)
  })

  it('returns true for named page routes', () => {
    expect(isKnownRoute('#/triage')).toBe(true)
    expect(isKnownRoute('#/action-queue')).toBe(true)
    expect(isKnownRoute('#/action-queue/sub')).toBe(true)
    expect(isKnownRoute('#/progress')).toBe(true)
    expect(isKnownRoute('#/events')).toBe(true)
    expect(isKnownRoute('#/kpi')).toBe(true)
    expect(isKnownRoute('#/kpi/cost_per_arc')).toBe(true)
    expect(isKnownRoute('#/steward')).toBe(true)
    expect(isKnownRoute('#/control')).toBe(true)
    expect(isKnownRoute('#/proposals')).toBe(true)
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
    expect(parseTaskRoute('#/task/x?from=chat')).toBe('x')
  })
})

// ---------------------------------------------------------------------------
// parseTaskOrigin — reads the `from` query param off a task hash
// ---------------------------------------------------------------------------

describe('parseTaskOrigin', () => {
  it('returns the route from ?from=<route>', () => {
    expect(parseTaskOrigin('#/task/x?from=chat')).toBe('chat')
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
    expect(parseTaskOrigin('#/proposal/x?from=chat')).toBeNull()
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
    expect(taskHash('x', 'chat')).toBe('#/task/x?from=chat')
  })

  it('percent-encodes the id', () => {
    expect(taskHash('mars-123', 'chat')).toBe(
      '#/task/mars-123?from=chat',
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
    expect(proposalHash('x', 'chat')).toBe('#/proposal/x?from=chat')
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

describe('parseTriageKind', () => {
  // Regression: the header's parked-task chip linked to this hash while the
  // Triage page read its filter from useState(''), so the chip navigated and
  // the page did not change. The link and the reader must stay in step.
  it('reads the kind the parked-task chip links to', () => {
    expect(parseTriageKind('#/triage?kind=awaiting-human')).toBe('awaiting-human')
  })

  it('returns the raw kind, not the short display label', () => {
    // The filter's <option> values are raw kinds; 'awaiting' is only what the
    // label map renders. Returning the label here would select nothing.
    expect(parseTriageKind('#/triage?kind=awaiting-human')).not.toBe('awaiting')
  })

  it('returns null for a Triage hash with no kind', () => {
    expect(parseTriageKind('#/triage')).toBeNull()
    expect(parseTriageKind('#/triage?other=1')).toBeNull()
    expect(parseTriageKind('#/triage?kind=')).toBeNull()
  })

  it('ignores a kind on some other route', () => {
    expect(parseTriageKind('#/events?kind=failed')).toBeNull()
    expect(parseTriageKind('#/task/x?kind=failed')).toBeNull()
  })

  it('decodes a percent-encoded kind and survives a bad one', () => {
    expect(parseTriageKind('#/triage?kind=draft%2Dproposal')).toBe('draft-proposal')
    expect(parseTriageKind('#/triage?kind=%E0%A4%A')).toBeNull()
  })

  it('finds kind among other params', () => {
    expect(parseTriageKind('#/triage?from=chat&kind=failed')).toBe('failed')
  })
})

describe('parseProposalOrigin', () => {
  it('returns the route from ?from=<route>', () => {
    expect(parseProposalOrigin('#/proposal/x?from=chat')).toBe('chat')
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
    expect(parseProposalOrigin('#/task/x?from=chat')).toBeNull()
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
    expect(resolvePageRoute('#/task/x?from=chat')).toBe('chat')
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

  it('returns triage for an empty hash (triage is the default landing page)', () => {
    expect(resolvePageRoute('')).toBe('triage')
  })

  it('returns chat for a malformed #/task/ hash (empty id)', () => {
    // A stray '#/task/' must not open a blank overlay or force the progress route.
    // It falls through to the detectRoute fallback, which is 'chat'.
    expect(resolvePageRoute('#/task/')).toBe('chat')
  })

  it('returns progress when a proposal overlay hash is present (no from)', () => {
    expect(resolvePageRoute('#/proposal/prop-abc')).toBe('progress')
  })

  it('returns the from-route when a proposal overlay carries ?from=chat', () => {
    // Opening the proposal drawer from the Action Queue should keep AQ mounted
    // behind it and closing returns there — matching task drawer behaviour.
    expect(resolvePageRoute('#/proposal/x?from=chat')).toBe('chat')
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
  it('returns "Needs You — mars" for the triage route', () => {
    expect(pageTitle('triage')).toBe('Needs You — mars')
  })

  it('returns "Chat — mars" for the chat route', () => {
    expect(pageTitle('chat')).toBe('Chat — mars')
  })

  it('returns "Progress — mars" for the progress route', () => {
    expect(pageTitle('progress')).toBe('Progress — mars')
  })

  it('returns "Events — mars" for the events route', () => {
    expect(pageTitle('events')).toBe('Events — mars')
  })

  it('returns "KPIs — mars" for the kpi route', () => {
    expect(pageTitle('kpi')).toBe('KPIs — mars')
  })

  it('returns "Steward — mars" for the steward route', () => {
    expect(pageTitle('steward')).toBe('Steward — mars')
  })

  it('returns "Control Room — mars" for the control route', () => {
    expect(pageTitle('control')).toBe('Control Room — mars')
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

  it('detectRoute falls back to chat for a bare #/studio/', () => {
    expect(detectRoute('#/studio/')).toBe('chat')
  })

  it('isKnownRoute accepts #/studio/<id>', () => {
    expect(isKnownRoute('#/studio/mars-abc')).toBe(true)
  })

  it('isKnownRoute accepts bare #/studio (Studio index)', () => {
    expect(isKnownRoute('#/studio')).toBe(true)
  })

  it('isKnownRoute rejects #/studio/ (trailing slash, no id)', () => {
    expect(isKnownRoute('#/studio/')).toBe(false)
  })

  it('detectRoute resolves bare #/studio to studio (index)', () => {
    expect(detectRoute('#/studio')).toBe('studio')
  })

  it('resolvePageRoute resolves bare #/studio to studio (index)', () => {
    expect(resolvePageRoute('#/studio')).toBe('studio')
  })

  it('detectRoute still falls back to chat for #/studio/ (trailing slash, no id)', () => {
    expect(detectRoute('#/studio/')).toBe('chat')
  })

  it('resolvePageRoute resolves #/studio/<id> to studio', () => {
    expect(resolvePageRoute('#/studio/mars-abc')).toBe('studio')
  })

  it('pageTitle returns "Scores — mars" for the studio route', () => {
    expect(pageTitle('studio')).toBe('Scores — mars')
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

  it('routes a name the built-in list does not contain', () => {
    // A primitive an operator registers in their own workflow code executes
    // fine and is served by the daemon's live registry. This used to return
    // null for exactly those names, so the router rendered "<name> is not a
    // known primitive" — contradicting the API. Validation belongs to the
    // daemon; the drawer fetches and renders whatever comes back.
    expect(parsePrimitiveRoute('#/primitive/deployToStaging')).toBe('deployToStaging')
    expect(parsePrimitiveRoute('#/primitive/setupworktree')).toBe('setupworktree')
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
  it('isKnownRoute accepts known names', () => {
    expect(isKnownRoute('#/primitive/verify')).toBe(true)
  })

  it('isKnownRoute accepts unknown names so they render a not-found overlay (no redirect)', () => {
    // Prior behaviour was false (redirect to #/progress). The new behaviour renders
    // a not-found overlay instead, so any non-empty #/primitive/<name> is "known".
    expect(isKnownRoute('#/primitive/typo')).toBe(true)
  })

  it('isKnownRoute still rejects a bare #/primitive/ (empty segment)', () => {
    expect(isKnownRoute('#/primitive/')).toBe(false)
  })

  it('resolvePageRoute keeps Progress mounted beneath the primitive overlay', () => {
    expect(resolvePageRoute('#/primitive/merge')).toBe('progress')
  })

  it('detectRoute leaves the underlying page resolution to resolvePageRoute', () => {
    // A primitive hash is an overlay, not a page route — detectRoute's
    // default applies and resolvePageRoute overrides it to progress.
    expect(detectRoute('#/primitive/verify')).toBe('chat')
    expect(resolvePageRoute('#/primitive/verify')).toBe('progress')
  })
})

// ---------------------------------------------------------------------------
// parseOverlayOrigin — generic ?from= for any overlay hash
// ---------------------------------------------------------------------------

describe('parseOverlayOrigin', () => {
  it('reads from= from a proposal-node hash', () => {
    expect(parseOverlayOrigin('#/proposal-node/x?from=chat')).toBe('chat')
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
    expect(proposalNodeHash('x', 'chat')).toBe('#/proposal-node/x?from=chat')
  })
})

// ---------------------------------------------------------------------------
// resolvePageRoute — overlay ?from= support for proposal-node and primitive
// ---------------------------------------------------------------------------

describe('resolvePageRoute — overlay from support', () => {
  it('proposal-node with ?from=events keeps events mounted', () => {
    expect(resolvePageRoute('#/proposal-node/x?from=events')).toBe('events')
  })

  it('proposal-node with ?from=chat keeps AQ mounted', () => {
    expect(resolvePageRoute('#/proposal-node/x?from=chat')).toBe('chat')
  })

  it('primitive with ?from=events keeps events mounted', () => {
    expect(resolvePageRoute('#/primitive/verify?from=events')).toBe('events')
  })

  it('primitive with no ?from= defaults to progress', () => {
    expect(resolvePageRoute('#/primitive/verify')).toBe('progress')
  })
})

describe('resolvePageRoute – overlay hashes keep the underlying page active', () => {
  it('resolves a bare task overlay to Progress, not the chat default', () => {
    // `#/task/<id>` renders a drawer ON TOP of the board. detectRoute has no
    // overlay cases and falls through to its 'chat' default, so a NavBar built
    // on it lit up Chat whenever a task was opened from the board.
    expect(detectRoute('#/task/mars-78858e6a')).toBe('chat')
    expect(resolvePageRoute('#/task/mars-78858e6a')).toBe('progress')
  })

  it('honours the recorded origin page when the overlay carries one', () => {
    expect(resolvePageRoute('#/task/mars-78858e6a?from=chat')).toBe('chat')
  })
})

// ---------------------------------------------------------------------------
// safeDecode — URIError guard
// ---------------------------------------------------------------------------

describe('safeDecode', () => {
  it('decodes a valid percent-encoded string', () => {
    expect(safeDecode('hello%20world')).toBe('hello world')
  })

  it('returns the input unchanged when there is nothing to decode', () => {
    expect(safeDecode('mars-abc123')).toBe('mars-abc123')
  })

  it('returns null for a bare percent sign (malformed encoding)', () => {
    expect(safeDecode('%')).toBeNull()
  })

  it('returns null for %ZZ (non-hex digits after %)', () => {
    expect(safeDecode('%ZZ')).toBeNull()
  })

  it('returns null for a truncated sequence like %2', () => {
    expect(safeDecode('%2')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// malformed hash resilience — no throws on stray %
// ---------------------------------------------------------------------------

describe('malformed hash resilience', () => {
  it('detectRoute does not throw on #/task/%', () => {
    expect(() => detectRoute('#/task/%')).not.toThrow()
  })

  it('parseTaskRoute returns null for #/task/% (malformed encoding)', () => {
    expect(parseTaskRoute('#/task/%')).toBeNull()
  })

  it('detectRoute does not throw on #/chat?q=100%', () => {
    // A stray % in a query param must not propagate the URIError
    expect(() => detectRoute('#/chat?q=100%')).not.toThrow()
  })

  it('parseProposalRoute returns null for #/proposal/% (malformed encoding)', () => {
    expect(parseProposalRoute('#/proposal/%')).toBeNull()
  })

  it('resolvePageRoute returns a valid route for #/task/% (falls back to chat)', () => {
    // parseTaskRoute returns null → falls through to detectRoute → 'chat'
    const result = resolvePageRoute('#/task/%')
    expect(result).toBe('chat')
  })
})

// ---------------------------------------------------------------------------
// taskHash round-trip — ids with special characters
// ---------------------------------------------------------------------------

describe('taskHash round-trip with special characters', () => {
  it('encodes a slash in the task id so parseTaskRoute round-trips it', () => {
    const id = 'fix/abc 1'
    const hash = taskHash(id)
    expect(hash).toBe('#/task/fix%2Fabc%201')
    expect(parseTaskRoute(hash)).toBe(id)
  })

  it('encodes a hash character so parseTaskRoute round-trips it', () => {
    const id = 'task#1'
    const hash = taskHash(id)
    expect(parseTaskRoute(hash)).toBe(id)
  })

  it('encodes a question mark so parseTaskRoute round-trips it', () => {
    const id = 'task?foo'
    const hash = taskHash(id)
    expect(parseTaskRoute(hash)).toBe(id)
  })
})

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// isKnownRoute — unknown primitive name is now a known address
// ---------------------------------------------------------------------------

describe('isKnownRoute — unknown primitive names', () => {
  it('returns true for a valid primitive name', () => {
    expect(isKnownRoute('#/primitive/runAgent')).toBe(true)
  })

  it('returns true for an unknown primitive name (not-found overlay, no redirect)', () => {
    expect(isKnownRoute('#/primitive/task')).toBe(true)
    expect(isKnownRoute('#/primitive/bogus')).toBe(true)
  })

  it('returns false for a bare #/primitive/ (empty segment)', () => {
    expect(isKnownRoute('#/primitive/')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolvePageRoute — unknown primitive hash keeps Progress as the backing page
// ---------------------------------------------------------------------------

describe('resolvePageRoute — unknown primitive name', () => {
  it('returns progress for an unknown primitive name', () => {
    expect(resolvePageRoute('#/primitive/task')).toBe('progress')
    expect(resolvePageRoute('#/primitive/bogus')).toBe('progress')
  })

  it('returns progress for a valid primitive name (unchanged)', () => {
    expect(resolvePageRoute('#/primitive/runAgent')).toBe('progress')
  })
})
