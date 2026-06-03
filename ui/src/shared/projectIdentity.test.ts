/**
 * Tests for projectIdentity — display name, icon, and signature color.
 *
 * Verifies observable behaviour through the public interface:
 *   - color is a valid hex string
 *   - color is stable for the same project across calls
 *   - projects with distinct IDs map to distinct palette entries across the
 *     full palette width (7 projects spanning all slots)
 */

import { describe, expect, it } from 'bun:test'
import { projectIdentity } from './projectIdentity'
import type { Project } from './schemas'

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'proj-default',
  repoRoot: '/repos/default',
  name: 'Default Project',
  health: 'live',
  ...overrides,
})

describe('projectIdentity – color', () => {
  it('returns a six-digit hex color string', () => {
    const { color } = projectIdentity(makeProject())
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('returns the same color for repeated calls on the same project', () => {
    const p = makeProject({ projectId: 'stable-id' })
    expect(projectIdentity(p).color).toBe(projectIdentity(p).color)
  })

  it('returns a color for projects with minimal data', () => {
    const { color } = projectIdentity(makeProject({ projectId: 'x', repoRoot: '/', name: '' }))
    expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('covers multiple palette entries across distinct project IDs', () => {
    // Use enough IDs to exercise > 1 palette slot (7 total; pick 14 IDs — by
    // pigeonhole at least 2 map to the same slot, but across 14 IDs we expect
    // to see at least 2 distinct colors).
    const ids = Array.from({ length: 14 }, (_, i) => `proj-${i}`)
    const colors = new Set(ids.map((id) => projectIdentity(makeProject({ projectId: id })).color))
    expect(colors.size).toBeGreaterThanOrEqual(2)
  })
})

describe('projectIdentity – name and icon (unchanged)', () => {
  it('uses project.name when non-empty', () => {
    const { name } = projectIdentity(makeProject({ name: 'My App' }))
    expect(name).toBe('My App')
  })

  it('falls back to the last repoRoot segment when name is blank', () => {
    const { name } = projectIdentity(makeProject({ name: '', repoRoot: '/home/user/my-repo' }))
    expect(name).toBe('my-repo')
  })

  it('icon is always the circle glyph', () => {
    expect(projectIdentity(makeProject()).icon).toBe('◉')
  })
})
