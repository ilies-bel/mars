import { describe, expect, it } from 'vitest'
import {
  formatPortRegistry,
  getPortRegistryEntry,
  loadPortRegistry,
  portRegistryEntrySchema,
  resolvePortKind,
  PORT_NAMES,
  type PortName,
} from '../registry.js'

describe('loadPortRegistry()', () => {
  it('returns a non-empty array', () => {
    expect(loadPortRegistry().length).toBeGreaterThan(0)
  })

  it('returns a defensive copy — mutations do not affect the catalog', () => {
    const first = loadPortRegistry()
    first.length = 0
    expect(loadPortRegistry().length).toBeGreaterThan(0)
  })

  it('has exactly one entry per declared Port name', () => {
    const ports = loadPortRegistry().map((e) => e.port)
    expect(new Set(ports).size).toBe(ports.length)
    expect(ports.sort()).toEqual([...PORT_NAMES].sort())
  })

  it('every entry validates against portRegistryEntrySchema', () => {
    for (const entry of loadPortRegistry()) {
      expect(() => portRegistryEntrySchema.parse(entry)).not.toThrow()
    }
  })

  it('every entry declares its defaultKind among its own implementations', () => {
    for (const entry of loadPortRegistry()) {
      const kinds = entry.implementations.map((impl) => impl.kind)
      expect(kinds, `${entry.port}: defaultKind must be a registered implementation`).toContain(entry.defaultKind)
    }
  })

  it('implementation kinds are unique within each Port', () => {
    for (const entry of loadPortRegistry()) {
      const kinds = entry.implementations.map((impl) => impl.kind)
      expect(new Set(kinds).size, `${entry.port}: duplicate implementation kind`).toBe(kinds.length)
    }
  })
})

describe('getPortRegistryEntry()', () => {
  it('returns the matching entry for a declared Port', () => {
    expect(getPortRegistryEntry('vcs').port).toBe('vcs')
  })

  it('throws for an undeclared Port', () => {
    expect(() => getPortRegistryEntry('nope' as PortName)).toThrow(/No Port registry entry/)
  })
})

describe('resolvePortKind()', () => {
  it('falls back to defaultKind when the env var is unset', () => {
    expect(resolvePortKind('vcs', {})).toBe('local-git')
  })

  it('falls back to defaultKind when the env var is empty', () => {
    expect(resolvePortKind('codeIndex', { MARS_CODE_INDEX_KIND: '' })).toBe('none')
  })

  it('returns the requested kind when it is registered', () => {
    expect(resolvePortKind('verifier', { MARS_VERIFIER_KIND: 'remote-http' })).toBe('remote-http')
  })

  it('throws when the requested kind is not registered', () => {
    expect(() => resolvePortKind('vcs', { MARS_VCS_KIND: 'locla-git' })).toThrow(/not a registered implementation/)
  })
})

describe('formatPortRegistry()', () => {
  it('renders a heading for every entry', () => {
    const rendered = formatPortRegistry(loadPortRegistry())
    for (const entry of loadPortRegistry()) {
      expect(rendered).toContain(`### ${entry.port}`)
      expect(rendered).toContain(entry.envVar)
    }
  })

  it('marks the default implementation', () => {
    const rendered = formatPortRegistry(loadPortRegistry())
    expect(rendered).toContain('`local-git` (default)')
  })

  it('returns a placeholder for an empty list', () => {
    expect(formatPortRegistry([])).toContain('no Ports in registry')
  })
})
