/**
 * Tests for projectIdentity — display name and hash-stable space-glyph icon.
 *
 * Behaviour verified:
 *   - same project name always yields the same icon (hash stability)
 *   - icon is one of the curated space-themed glyphs
 *   - name-derivation rules (project.name → last repoRoot segment → projectId)
 */

import { describe, expect, it } from 'bun:test'
import { projectIdentity } from './projectIdentity'
import type { Project } from './schemas'

// The curated set exported implicitly by the module; we mirror it here to
// assert membership without coupling to internal symbols.
const SPACE_GLYPHS = [
  '☄', '✦', '✧', '★', '☀', '☾', '⊙', '⊕', '◐', '♁', '♆', '✶', '✷', '❂', '☉',
]

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'test-id',
  repoRoot: '/repos/test',
  name: 'Test Project',
  health: 'live',
  ...overrides,
})

// ---------------------------------------------------------------------------
// Name derivation — unchanged from original logic
// ---------------------------------------------------------------------------

describe('projectIdentity – name derivation', () => {
  it('uses project.name when non-empty', () => {
    const { name } = projectIdentity(makeProject({ name: 'My App' }))
    expect(name).toBe('My App')
  })

  it('falls back to last segment of repoRoot when name is blank', () => {
    const { name } = projectIdentity(makeProject({ name: '  ', repoRoot: '/repos/alpha' }))
    expect(name).toBe('alpha')
  })

  it('falls back to projectId when name is blank and repoRoot has no segments', () => {
    const { name } = projectIdentity(makeProject({ name: '', repoRoot: '/', projectId: 'fallback-id' }))
    expect(name).toBe('fallback-id')
  })
})

// ---------------------------------------------------------------------------
// Icon — hash stability and membership
// ---------------------------------------------------------------------------

describe('projectIdentity – icon is a curated space glyph', () => {
  it('returns an icon that is one of the curated space glyphs', () => {
    const { icon } = projectIdentity(makeProject({ name: 'Alpha' }))
    expect(SPACE_GLYPHS).toContain(icon)
  })

  it('same project name always yields the same icon (stability)', () => {
    const p = makeProject({ name: 'Stable Name' })
    const { icon: first } = projectIdentity(p)
    const { icon: second } = projectIdentity(p)
    expect(first).toBe(second)
  })

  it('same name on different project records yields the same icon', () => {
    const { icon: icon1 } = projectIdentity(makeProject({ projectId: 'id1', repoRoot: '/r1', name: 'Shared' }))
    const { icon: icon2 } = projectIdentity(makeProject({ projectId: 'id2', repoRoot: '/r2', name: 'Shared', health: 'degraded' }))
    expect(icon1).toBe(icon2)
  })

  it('icon is stable across multiple calls for several distinct names', () => {
    const names = ['Orion', 'Vega', 'Sirius', 'Antares', 'Rigel', 'Betelgeuse']
    for (const name of names) {
      const { icon: a } = projectIdentity(makeProject({ name }))
      const { icon: b } = projectIdentity(makeProject({ name }))
      expect(a).toBe(b)
    }
  })
})
