import { describe, it, expect } from 'vitest'
import {
  MarsId,
  MarsIdPrefix,
  MarsIdParseError,
  parseMarsId,
} from './mars-id/index.js'

describe('MarsId.create', () => {
  it('renders a task id as mars-task-<hex>', () => {
    const id = MarsId.create('task', '04830c8e')
    expect(id.toString()).toBe('mars-task-04830c8e')
  })

  it('renders a proposal id with slug as mars-proposal-<hex>-<slug>', () => {
    const id = MarsId.create('proposal', '04830c8e', 'centralize-id-generation')
    expect(id.toString()).toBe('mars-proposal-04830c8e-centralize-id-generation')
  })

  it('renders a proposal id without slug as mars-proposal-<hex>', () => {
    const id = MarsId.create('proposal', '04830c8e')
    expect(id.toString()).toBe('mars-proposal-04830c8e')
  })

  it('rejects an invalid hex (non-hex chars)', () => {
    expect(() => MarsId.create('task', 'zzzzzzzz')).toThrow()
  })

  it('rejects a wrong-length hex', () => {
    expect(() => MarsId.create('task', '0483')).toThrow()
  })

  it('rejects an invalid slug shape', () => {
    expect(() => MarsId.create('proposal', '04830c8e', 'Bad Slug!')).toThrow()
  })
})

describe('parseMarsId — round-trip', () => {
  const bare = '04830c8e'

  it('parses the full rendered task form to a MarsId', () => {
    const r = parseMarsId(`mars-task-${bare}`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('id')
    if (r.kind !== 'id') return
    expect(r.value.kind).toBe('task')
    expect(r.value.hex).toBe(bare)
    expect(r.value.slug).toBeUndefined()
  })

  it('parses the full rendered proposal form with slug to a MarsId', () => {
    const r = parseMarsId(`mars-proposal-${bare}-foo-bar-baz`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('id')
    if (r.kind !== 'id') return
    expect(r.value.kind).toBe('proposal')
    expect(r.value.hex).toBe(bare)
    expect(r.value.slug).toBe('foo-bar-baz')
  })

  it('parses the proposal prefix-without-slug form to a MarsId', () => {
    const r = parseMarsId(`mars-proposal-${bare}`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('id')
    if (r.kind !== 'id') return
    expect(r.value.kind).toBe('proposal')
    expect(r.value.hex).toBe(bare)
    expect(r.value.slug).toBeUndefined()
  })

  it('parses a bare 8-hex to a MarsIdPrefix (kind unknown)', () => {
    const r = parseMarsId(bare)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('prefix')
    if (r.kind !== 'prefix') return
    expect(r.value.hex).toBe(bare)
  })

  it('parses a short hex prefix to a MarsIdPrefix', () => {
    const r = parseMarsId('0483')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('prefix')
    if (r.kind !== 'prefix') return
    expect(r.value.hex).toBe('0483')
  })

  it('round-trips all four user-facing shapes back to the same bare hex', () => {
    const shapes = [
      `mars-task-${bare}`, // full rendered (task)
      `mars-proposal-${bare}-some-slug`, // full rendered (proposal, with slug)
      `mars-proposal-${bare}`, // prefix without slug
      bare, // bare hex
      '0483', // hex prefix (different — partial)
    ]
    const hexes = shapes.map((s) => {
      const r = parseMarsId(s)
      if (!r.ok) throw new Error(`unexpected parse error for ${s}: ${r.error.message}`)
      if (r.kind === 'id') return r.value.hex
      return r.value.hex
    })
    // The first four are the full-hex shapes — they must all round-trip to `bare`.
    expect(hexes.slice(0, 4)).toEqual([bare, bare, bare, bare])
    // The fifth (hex prefix) preserves the partial prefix verbatim.
    expect(hexes[4]).toBe('0483')
  })
})

describe('parseMarsId — typed errors', () => {
  it('surfaces a typed error for an empty string', () => {
    const r = parseMarsId('')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(MarsIdParseError)
    expect(r.error.code).toBe('EMPTY')
  })

  it('surfaces a typed error for an unknown kind', () => {
    const r = parseMarsId('mars-thing-04830c8e')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UNKNOWN_KIND')
  })

  it('also rejects the legacy mars-idea- prefix (renamed to proposal)', () => {
    const r = parseMarsId('mars-idea-04830c8e')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UNKNOWN_KIND')
  })

  it('surfaces a typed error for malformed hex inside a kinded form', () => {
    const r = parseMarsId('mars-task-zzzzzzzz')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INVALID_HEX')
  })

  it('surfaces a typed error for a kinded form missing the hex segment', () => {
    const r = parseMarsId('mars-task-')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INVALID_HEX')
  })

  it('surfaces a typed error for non-hex bare input', () => {
    const r = parseMarsId('not-a-mars-id-at-all')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('MALFORMED')
  })

  it('returns no partial value on error', () => {
    const r = parseMarsId('mars-task-')
    expect(r.ok).toBe(false)
    if (r.ok) return
    // The error shape has no `.value` or `.kind` to accidentally read from.
    expect((r as unknown as { value?: unknown }).value).toBeUndefined()
  })
})

describe('MarsId.equals', () => {
  it('returns true when hex matches even if kind differs', () => {
    const a = MarsId.create('task', '04830c8e')
    const b = MarsId.create('proposal', '04830c8e', 'some-slug')
    expect(a.equals(b)).toBe(true)
    expect(b.equals(a)).toBe(true)
  })

  it('returns false when hex differs', () => {
    const a = MarsId.create('task', '04830c8e')
    const b = MarsId.create('task', '04830c8f')
    expect(a.equals(b)).toBe(false)
  })

  it('returns true when only slug differs', () => {
    const a = MarsId.create('proposal', '04830c8e', 'one-slug')
    const b = MarsId.create('proposal', '04830c8e', 'another-slug')
    expect(a.equals(b)).toBe(true)
  })
})

describe('MarsIdPrefix', () => {
  it('matches a MarsId whose hex starts with the prefix', () => {
    const p = MarsIdPrefix.create('0483')
    const id = MarsId.create('task', '04830c8e')
    expect(p.matches(id)).toBe(true)
  })

  it('does not match a MarsId with a different prefix', () => {
    const p = MarsIdPrefix.create('0483')
    const id = MarsId.create('task', '12340c8e')
    expect(p.matches(id)).toBe(false)
  })

  it('matches a bare hex string when prefix aligns', () => {
    const p = MarsIdPrefix.create('0483')
    expect(p.matches('04830c8e')).toBe(true)
    expect(p.matches('99990c8e')).toBe(false)
  })

  it('is a distinct type from MarsId', () => {
    const p = MarsIdPrefix.create('0483')
    const id = MarsId.create('task', '04830c8e')
    expect(p).not.toBeInstanceOf(MarsId)
    expect(id).not.toBeInstanceOf(MarsIdPrefix)
  })

  it('cannot be rendered as a final user-facing id (no mars- form)', () => {
    const p = MarsIdPrefix.create('0483')
    // The prefix carries no kind, so it must not stringify to a
    // `mars-<kind>-...` shape that downstream code could mistake for a
    // final id.
    expect(String(p)).not.toMatch(/^mars-(task|proposal)-/)
    // And it does not expose a `toRenderedForm()` / similar that returns
    // a kinded id.
    expect((p as unknown as Record<string, unknown>).toRenderedForm).toBeUndefined()
  })

  it('rejects an empty or over-length hex', () => {
    expect(() => MarsIdPrefix.create('')).toThrow()
    expect(() => MarsIdPrefix.create('04830c8e9')).toThrow()
  })

  it('rejects non-hex characters', () => {
    expect(() => MarsIdPrefix.create('zzzz')).toThrow()
  })
})
