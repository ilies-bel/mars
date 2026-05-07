import { describe, expect, it } from 'vitest'
import { stripFrontmatter } from '../git'

describe('stripFrontmatter', () => {
  it('strips a leading YAML frontmatter block', () => {
    expect(stripFrontmatter('---\nname: x\n---\n\nbody')).toBe('body')
  })

  it('returns text unchanged when no frontmatter is present', () => {
    expect(stripFrontmatter('no frontmatter')).toBe('no frontmatter')
  })

  it('returns text unchanged when frontmatter has no closing delimiter', () => {
    const input = '---\nname: x\nstill going'
    expect(stripFrontmatter(input)).toBe(input)
  })
})
