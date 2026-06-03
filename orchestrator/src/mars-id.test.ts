import { describe, it, expect } from 'vitest'
import {
  MarsId,
  MarsIdPrefix,
  MarsIdParseError,
  parseMarsId,
  KIND_TAGS,
} from './mars-id/index.js'
import { genId } from './mars-id/kinds.js'

describe('MarsId.create', () => {
  it('renders a task id as task-<hex>', () => {
    const id = MarsId.create('task', '04830c8e')
    expect(id.toString()).toBe('task-04830c8e')
  })

  it('renders a proposal id as prop-<hex>', () => {
    const id = MarsId.create('proposal', '04830c8e')
    expect(id.toString()).toBe('prop-04830c8e')
  })

  it('rejects an invalid hex (non-hex chars)', () => {
    expect(() => MarsId.create('task', 'zzzzzzzz')).toThrow()
  })

  it('rejects a wrong-length hex', () => {
    expect(() => MarsId.create('task', '0483')).toThrow()
  })
})

describe('parseMarsId — round-trip', () => {
  const bare = '04830c8e'

  it('parses the full tagged task form to a MarsId', () => {
    const r = parseMarsId(`task-${bare}`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('id')
    if (r.kind !== 'id') return
    expect(r.value.kind).toBe('task')
    expect(r.value.hex).toBe(bare)
  })

  it('parses the full tagged proposal form to a MarsId', () => {
    const r = parseMarsId(`prop-${bare}`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.kind).toBe('id')
    if (r.kind !== 'id') return
    expect(r.value.kind).toBe('proposal')
    expect(r.value.hex).toBe(bare)
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

  it('round-trips all user-facing shapes back to the same bare hex', () => {
    const shapes = [
      `task-${bare}`, // full tagged (task)
      `prop-${bare}`, // full tagged (proposal)
      bare,           // bare hex
      '0483',         // hex prefix (partial)
    ]
    const hexes = shapes.map((s) => {
      const r = parseMarsId(s)
      if (!r.ok) throw new Error(`unexpected parse error for ${s}: ${r.error.message}`)
      return r.value.hex
    })
    // The first three shapes all carry the full hex.
    expect(hexes.slice(0, 3)).toEqual([bare, bare, bare])
    // The fourth (hex prefix) preserves the partial prefix verbatim.
    expect(hexes[3]).toBe('0483')
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

  it('surfaces a typed error for an unknown kind tag', () => {
    const r = parseMarsId('unkn-04830c8e')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UNKNOWN_KIND')
  })

  it('surfaces a typed error for malformed hex inside a tagged form', () => {
    const r = parseMarsId('task-zzzzzzzz')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INVALID_HEX')
  })

  it('surfaces a typed error for a tagged form missing the hex segment', () => {
    const r = parseMarsId('task-')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('INVALID_HEX')
  })

  it('surfaces a typed error for non-hex bare input (no dash)', () => {
    const r = parseMarsId('notahex')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('MALFORMED')
  })

  it('returns no partial value on error', () => {
    const r = parseMarsId('task-')
    expect(r.ok).toBe(false)
    if (r.ok) return
    // The error shape has no `.value` or `.kind` to accidentally read from.
    expect((r as unknown as { value?: unknown }).value).toBeUndefined()
  })

  it('rejects legacy mars-abcd1234 shape', () => {
    const r = parseMarsId('mars-abcd1234')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UNKNOWN_KIND')
  })

  it('rejects legacy reflect-abcd1234 shape', () => {
    const r = parseMarsId('reflect-abcd1234')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UNKNOWN_KIND')
  })

  it('rejects legacy abcd1234-some-slug shape', () => {
    const r = parseMarsId('abcd1234-some-slug')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('UNKNOWN_KIND')
  })
})

describe('KIND_TAGS registry', () => {
  it('has a unique 4-letter tag for every registered kind', () => {
    const tags = Object.values(KIND_TAGS)
    // All tags are exactly 4 letters.
    for (const tag of tags) {
      expect(tag).toMatch(/^[a-z]{4}$/)
    }
    // All tags are unique.
    const unique = new Set(tags)
    expect(unique.size).toBe(tags.length)
  })

  it('enumerates the expected set of kinds', () => {
    const kinds = Object.keys(KIND_TAGS)
    expect(kinds).toContain('task')
    expect(kinds).toContain('proposal')
    expect(kinds).toContain('fix-task')
    expect(kinds).toContain('inbox-item')
    expect(kinds).toContain('reflection')
    expect(kinds).toContain('step-span')
    expect(kinds).toContain('inbox-history')
    expect(kinds).toContain('origin')
    expect(kinds).toContain('alert')
  })
})

describe('genId', () => {
  it('returns <tag>-<8 hex chars> for every registered kind', () => {
    for (const kind of Object.keys(KIND_TAGS) as Array<keyof typeof KIND_TAGS>) {
      const id = genId(kind)
      const tag = KIND_TAGS[kind]
      expect(id.toString()).toMatch(new RegExp(`^${tag}-[a-f0-9]{8}$`))
    }
  })

  it('round-trips every kind through parseMarsId', () => {
    for (const kind of Object.keys(KIND_TAGS) as Array<keyof typeof KIND_TAGS>) {
      const id = genId(kind)
      const r = parseMarsId(id.toString())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.kind).toBe('id')
      if (r.kind !== 'id') return
      expect(r.value.kind).toBe(kind)
      expect(r.value.hex).toBe(id.hex)
    }
  })
})

describe('MarsId.equals', () => {
  it('returns true when hex matches even if kind differs', () => {
    const a = MarsId.create('task', '04830c8e')
    const b = MarsId.create('proposal', '04830c8e')
    expect(a.equals(b)).toBe(true)
    expect(b.equals(a)).toBe(true)
  })

  it('returns false when hex differs', () => {
    const a = MarsId.create('task', '04830c8e')
    const b = MarsId.create('task', '04830c8f')
    expect(a.equals(b)).toBe(false)
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

  it('cannot be rendered as a final user-facing id (no tag- form)', () => {
    const p = MarsIdPrefix.create('0483')
    // The prefix carries no kind, so it must not stringify to a
    // `<tag>-...` shape that downstream code could mistake for a final id.
    expect(String(p)).not.toMatch(/^(task|prop|refl|span|fixt|inbx|inbh|orig|alrt)-/)
    // And it does not expose a `toRenderedForm()` / similar.
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
