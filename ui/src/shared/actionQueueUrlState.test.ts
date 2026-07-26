import { describe, expect, it } from 'bun:test'
import {
  defaultAqUrlState,
  decodeAqState,
  encodeAqState,
} from './actionQueueUrlState'

// ---------------------------------------------------------------------------
// thread field — encode
// ---------------------------------------------------------------------------

describe('encodeAqState — thread field', () => {
  it('omits thread param when thread is null (clean default URL)', () => {
    const result = encodeAqState(defaultAqUrlState())
    expect(result).toBe('')
    expect(result).not.toContain('thread')
  })

  it('emits thread=<encoded-id> when thread is set', () => {
    const result = encodeAqState({ ...defaultAqUrlState(), thread: 't-123' })
    expect(result).toContain('thread=t-123')
  })

  it('percent-encodes thread ids that require escaping', () => {
    const result = encodeAqState({ ...defaultAqUrlState(), thread: 'my thread/id' })
    expect(result).toContain('thread=my%20thread%2Fid')
  })

  it('begins with ? when thread is the only non-default field', () => {
    const result = encodeAqState({ ...defaultAqUrlState(), thread: 't-abc' })
    expect(result).toBe('?thread=t-abc')
  })

  it('includes thread alongside other non-default fields', () => {
    const result = encodeAqState({
      item: null,
      kind: 'alerts',
      q: 'hello',
      thread: 't-xyz',
    })
    expect(result).toContain('kind=alerts')
    expect(result).toContain('q=hello')
    expect(result).toContain('thread=t-xyz')
  })
})

// ---------------------------------------------------------------------------
// thread field — decode
// ---------------------------------------------------------------------------

describe('decodeAqState — thread field', () => {
  it('returns thread null when no thread param is present', () => {
    expect(decodeAqState('#/chat').thread).toBeNull()
    expect(decodeAqState('#/chat?kind=alerts').thread).toBeNull()
  })

  it('decodes a bare thread id from #/chat?thread=t-123', () => {
    expect(decodeAqState('#/chat?thread=t-123').thread).toBe('t-123')
  })

  it('decodes a percent-encoded thread id', () => {
    expect(decodeAqState('#/chat?thread=my%20thread%2Fid').thread).toBe('my thread/id')
  })

  it('returns thread null when thread param is an empty string', () => {
    expect(decodeAqState('#/chat?thread=').thread).toBeNull()
  })

  it('decodes thread alongside other params', () => {
    const state = decodeAqState('#/chat?kind=alerts&thread=t-456&q=foo')
    expect(state.thread).toBe('t-456')
    expect(state.kind).toBe('alerts')
    expect(state.q).toBe('foo')
  })
})

// ---------------------------------------------------------------------------
// round-trip: encode → decode
// ---------------------------------------------------------------------------

describe('round-trip encode/decode for thread field', () => {
  it('thread set round-trips through encode then decode', () => {
    const original = { ...defaultAqUrlState(), thread: 't-abc' }
    const encoded = encodeAqState(original)
    const decoded = decodeAqState(`#/chat${encoded}`)
    expect(decoded.thread).toBe('t-abc')
  })

  it('thread null round-trips (omitted in encode, null in decode)', () => {
    const original = defaultAqUrlState()
    const encoded = encodeAqState(original)
    // encoded is '' for all-defaults, decodeAqState handles bare hash
    const decoded = decodeAqState(`#/chat${encoded}`)
    expect(decoded.thread).toBeNull()
  })

  it('exclusive selection: thread set and item null round-trips correctly', () => {
    const original = { item: null, kind: 'all' as const, q: '', thread: 't-999' }
    const decoded = decodeAqState(`#/chat${encodeAqState(original)}`)
    expect(decoded.thread).toBe('t-999')
    expect(decoded.item).toBeNull()
  })

  it('exclusive selection: item set and thread null round-trips correctly', () => {
    const original = { item: 'failed-task:t-1', kind: 'all' as const, q: '', thread: null }
    const decoded = decodeAqState(`#/chat${encodeAqState(original)}`)
    expect(decoded.item).toBe('failed-task:t-1')
    expect(decoded.thread).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// project field — encode
// ---------------------------------------------------------------------------

describe('encodeAqState — project field', () => {
  it('omits project param when project is null (clean default URL)', () => {
    const result = encodeAqState(defaultAqUrlState())
    expect(result).toBe('')
    expect(result).not.toContain('project')
  })

  it('emits project=<encoded-id> when project is set', () => {
    const result = encodeAqState({ ...defaultAqUrlState(), project: 'proj-abc' })
    expect(result).toContain('project=proj-abc')
  })

  it('percent-encodes project ids that require escaping', () => {
    const result = encodeAqState({ ...defaultAqUrlState(), project: 'my project/id' })
    expect(result).toContain('project=my%20project%2Fid')
  })

  it('begins with ? when project is the only non-default field', () => {
    const result = encodeAqState({ ...defaultAqUrlState(), project: 'p-1' })
    expect(result).toBe('?project=p-1')
  })

  it('includes project alongside thread and other non-default fields', () => {
    const result = encodeAqState({
      ...defaultAqUrlState(),
      project: 'p-1',
      thread: 't-xyz',
    })
    expect(result).toContain('project=p-1')
    expect(result).toContain('thread=t-xyz')
  })
})

// ---------------------------------------------------------------------------
// project field — decode
// ---------------------------------------------------------------------------

describe('decodeAqState — project field', () => {
  it('returns project null when no project param is present', () => {
    expect(decodeAqState('#/chat').project).toBeNull()
    expect(decodeAqState('#/chat?thread=t-1').project).toBeNull()
  })

  it('decodes a bare project id from ?project=p-123', () => {
    expect(decodeAqState('#/chat?project=p-123').project).toBe('p-123')
  })

  it('decodes a percent-encoded project id', () => {
    expect(decodeAqState('#/chat?project=my%20project%2Fid').project).toBe('my project/id')
  })

  it('returns project null when project param is an empty string', () => {
    expect(decodeAqState('#/chat?project=').project).toBeNull()
  })

  it('decodes project alongside thread param', () => {
    const state = decodeAqState('#/chat?project=p-1&thread=t-456')
    expect(state.project).toBe('p-1')
    expect(state.thread).toBe('t-456')
  })
})

// ---------------------------------------------------------------------------
// project round-trip: encode → decode
// ---------------------------------------------------------------------------

describe('round-trip encode/decode for project field', () => {
  it('project set round-trips through encode then decode', () => {
    const original = { ...defaultAqUrlState(), project: 'proj-abc' }
    const encoded = encodeAqState(original)
    const decoded = decodeAqState(`#/chat${encoded}`)
    expect(decoded.project).toBe('proj-abc')
  })

  it('project null round-trips (omitted in encode, null in decode)', () => {
    const original = defaultAqUrlState()
    const encoded = encodeAqState(original)
    const decoded = decodeAqState(`#/chat${encoded}`)
    expect(decoded.project).toBeNull()
  })

  it('project and thread together round-trip correctly', () => {
    const original = { ...defaultAqUrlState(), project: 'p-1', thread: 't-999' }
    const encoded = encodeAqState(original)
    const decoded = decodeAqState(`#/chat${encoded}`)
    expect(decoded.project).toBe('p-1')
    expect(decoded.thread).toBe('t-999')
  })
})

// ---------------------------------------------------------------------------
// defaultAqUrlState includes thread: null and project: null
// ---------------------------------------------------------------------------

describe('defaultAqUrlState', () => {
  it('includes thread: null', () => {
    expect(defaultAqUrlState().thread).toBeNull()
  })

  it('includes project: null', () => {
    expect(defaultAqUrlState().project).toBeNull()
  })

  it('returns a new object each call', () => {
    expect(defaultAqUrlState()).not.toBe(defaultAqUrlState())
  })
})
