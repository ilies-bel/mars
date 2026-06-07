import { describe, expect, it } from 'bun:test'
import {
  decodeProgressState,
  defaultProgressUrlState,
  encodeProgressState,
  type ProgressUrlState,
} from './progressUrlState'

// ---------------------------------------------------------------------------
// decodeProgressState — parse URL hash into filter state
// ---------------------------------------------------------------------------

describe('decodeProgressState', () => {
  it('returns defaults for a bare #/progress hash', () => {
    const state = decodeProgressState('#/progress')
    const defaults = defaultProgressUrlState()
    expect(state.view).toBe(defaults.view)
    expect(state.query).toBe(defaults.query)
    expect(state.proposal).toBeNull()
  })

  it('returns defaults when there is no query string', () => {
    const state = decodeProgressState('#/progress')
    expect(state.view).toBe('topology')
    expect(state.query).toBe('')
    expect(state.proposal).toBeNull()
  })

  it('decodes board view', () => {
    expect(decodeProgressState('#/progress?view=board').view).toBe('board')
  })

  it('falls back to topology for an unknown view value', () => {
    expect(decodeProgressState('#/progress?view=bogus').view).toBe('topology')
  })

  it('decodes search query', () => {
    expect(decodeProgressState('#/progress?q=hello%20world').query).toBe(
      'hello world',
    )
  })

  it('decodes a percent-encoded search query', () => {
    expect(decodeProgressState('#/progress?q=deploy%2Fmain').query).toBe(
      'deploy/main',
    )
  })

  it('decodes proposal id', () => {
    expect(decodeProgressState('#/progress?proposal=p-abc123').proposal).toBe(
      'p-abc123',
    )
  })

  it('returns null proposal when param is absent', () => {
    expect(decodeProgressState('#/progress').proposal).toBeNull()
  })

  it('returns null proposal for an empty param value', () => {
    expect(decodeProgressState('#/progress?proposal=').proposal).toBeNull()
  })

  it('silently ignores the legacy recency param', () => {
    // The recency param no longer exists; old URLs with it should not throw.
    const state = decodeProgressState('#/progress?recency=7d')
    expect(state.view).toBe('topology')
  })
})

// ---------------------------------------------------------------------------
// encodeProgressState — serialise filter state to a query string
// ---------------------------------------------------------------------------

describe('encodeProgressState', () => {
  it('returns an empty string for default state', () => {
    expect(encodeProgressState(defaultProgressUrlState())).toBe('')
  })

  it('encodes a non-default view', () => {
    const state: ProgressUrlState = { ...defaultProgressUrlState(), view: 'board' }
    expect(encodeProgressState(state)).toContain('view=board')
  })

  it('omits the view param for the default topology tab', () => {
    const state: ProgressUrlState = { ...defaultProgressUrlState(), view: 'topology' }
    expect(encodeProgressState(state)).not.toContain('view=')
  })

  it('encodes a non-empty search query', () => {
    const state: ProgressUrlState = {
      ...defaultProgressUrlState(),
      query: 'hello world',
    }
    expect(encodeProgressState(state)).toContain('q=hello%20world')
  })

  it('omits the q param for an empty query', () => {
    const state: ProgressUrlState = { ...defaultProgressUrlState(), query: '' }
    expect(encodeProgressState(state)).not.toContain('q=')
  })

  it('encodes a proposal id', () => {
    const state: ProgressUrlState = {
      ...defaultProgressUrlState(),
      proposal: 'p-abc123',
    }
    expect(encodeProgressState(state)).toContain('proposal=p-abc123')
  })

  it('omits the proposal param when null', () => {
    const state: ProgressUrlState = { ...defaultProgressUrlState(), proposal: null }
    expect(encodeProgressState(state)).not.toContain('proposal=')
  })

  it('never encodes a recency param', () => {
    expect(encodeProgressState(defaultProgressUrlState())).not.toContain('recency=')
  })

  it('never encodes a clusters param', () => {
    expect(encodeProgressState(defaultProgressUrlState())).not.toContain('clusters=')
  })

  it('starts with ? when any param is present', () => {
    const state: ProgressUrlState = { ...defaultProgressUrlState(), view: 'board' }
    expect(encodeProgressState(state)).toMatch(/^\?/)
  })
})

// ---------------------------------------------------------------------------
// Round-trip — encode then decode yields the original values
// ---------------------------------------------------------------------------

describe('encode → decode round-trip', () => {
  it('restores view=board', () => {
    const state: ProgressUrlState = { ...defaultProgressUrlState(), view: 'board' }
    const restored = decodeProgressState(`#/progress${encodeProgressState(state)}`)
    expect(restored.view).toBe('board')
  })

  it('restores search query', () => {
    const state: ProgressUrlState = {
      ...defaultProgressUrlState(),
      query: 'deploy feature/x',
    }
    const restored = decodeProgressState(`#/progress${encodeProgressState(state)}`)
    expect(restored.query).toBe('deploy feature/x')
  })

  it('restores proposal id', () => {
    const state: ProgressUrlState = {
      ...defaultProgressUrlState(),
      proposal: 'prop-abc-123',
    }
    const restored = decodeProgressState(`#/progress${encodeProgressState(state)}`)
    expect(restored.proposal).toBe('prop-abc-123')
  })

  it('restores a fully non-default state', () => {
    const state: ProgressUrlState = {
      view: 'board',
      query: 'test search',
      proposal: 'p-abc',
    }
    const hash = `#/progress${encodeProgressState(state)}`
    const restored = decodeProgressState(hash)
    expect(restored.view).toBe('board')
    expect(restored.query).toBe('test search')
    expect(restored.proposal).toBe('p-abc')
  })
})
