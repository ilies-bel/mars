import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agents, getAgentSpec } from '../index'
import { stripFrontmatter } from '../../lib/git/merge'

const moduleDir = dirname(fileURLToPath(import.meta.url))

describe('agent registry', () => {
  it('exposes a vcs-supervisor entry', () => {
    expect(agents['vcs-supervisor']).toBeDefined()
    expect(agents['vcs-supervisor'].name).toBe('vcs-supervisor')
  })

  it('vcs-supervisor system prompt is non-empty and matches the previous markdown body', () => {
    const spec = agents['vcs-supervisor']
    expect(spec.systemPrompt.trim().length).toBeGreaterThan(0)

    const markdownPath = resolve(
      moduleDir,
      '../../public/prompts/vcs-supervisor.md',
    )
    const expected = stripFrontmatter(readFileSync(markdownPath, 'utf8')).trim()
    expect(spec.systemPrompt.trim()).toBe(expected)
  })

  it('getAgentSpec returns the entry by name', () => {
    const spec = getAgentSpec('vcs-supervisor')
    expect(spec).toBe(agents['vcs-supervisor'])
  })

  it('getAgentSpec throws on unknown names', () => {
    expect(() => getAgentSpec('not-a-real-agent')).toThrow(
      /unknown agent.*not-a-real-agent/i,
    )
  })
})
