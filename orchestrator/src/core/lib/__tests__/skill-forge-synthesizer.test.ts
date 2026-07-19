import { describe, expect, it } from 'vitest'
import { synthesizeSkillMarkdown } from '../skill-forge-synthesizer'
import type { CrossArcLesson } from '../skill-forge-detector'

const lesson: CrossArcLesson = {
  key: 'use-structured-tasks-for-clarity::task_spec_ambiguity',
  title: 'Use Structured Tasks for Clarity',
  summary: 'Always emit structured task specs when enqueueing work to reduce ambiguity.',
  motivatingArcOriginIds: ['arc-1', 'arc-2', 'arc-3'],
  triggerPhrases: ['add structured task', 'emit task spec', 'use structured tasks'],
}

describe('synthesizeSkillMarkdown', () => {
  it('returns a lowercase-kebab slug derived from the lesson title', () => {
    const { name } = synthesizeSkillMarkdown(lesson)
    expect(name).toBe('use-structured-tasks-for-clarity')
  })

  it('name matches the slug embedded in the frontmatter', () => {
    const { name, markdown } = synthesizeSkillMarkdown(lesson)
    expect(markdown).toContain(`name: ${name}`)
  })

  it('frontmatter name field is non-empty (mirrors skill-workflow-author.test.ts assertion)', () => {
    const { markdown } = synthesizeSkillMarkdown(lesson)
    expect(markdown).toMatch(/^name:\s+\S/m)
  })

  it('frontmatter description field is non-empty (mirrors skill-workflow-author.test.ts assertion)', () => {
    const { markdown } = synthesizeSkillMarkdown(lesson)
    expect(markdown).toMatch(/^description:\s+\S/m)
  })

  it('description includes at least one trigger phrase', () => {
    const { markdown } = synthesizeSkillMarkdown(lesson)
    const anyPhrase = (lesson.triggerPhrases ?? []).some(phrase => markdown.includes(phrase))
    expect(anyPhrase).toBe(true)
  })

  it('markdown opens with a YAML frontmatter block', () => {
    const { markdown } = synthesizeSkillMarkdown(lesson)
    expect(markdown).toMatch(/^---\n/)
    expect(markdown).toContain('\n---\n')
  })

  it('slug strips non-alphanumeric characters', () => {
    const edge: CrossArcLesson = {
      key: 'fix-use-no-verify-sparingly::hook_bypass',
      title: 'Fix: Use --no-verify Sparingly!',
      summary: 'Avoid skipping hooks.',
      motivatingArcOriginIds: ['arc-1', 'arc-2', 'arc-3'],
      triggerPhrases: ['skip hooks'],
    }
    const { name } = synthesizeSkillMarkdown(edge)
    expect(name).toBe('fix-use-no-verify-sparingly')
  })

  it('falls back to summary for body when no body is provided', () => {
    const { markdown } = synthesizeSkillMarkdown(lesson)
    expect(markdown).toContain(lesson.summary)
  })

  it('uses explicit body when provided', () => {
    const withBody: CrossArcLesson = {
      ...lesson,
      body: 'Extended body content for the skill.',
    }
    const { markdown } = synthesizeSkillMarkdown(withBody)
    expect(markdown).toContain('Extended body content for the skill.')
  })
})
