/**
 * Tests for chat-skills.ts — skill discovery, frontmatter parsing, loading,
 * and the instructions index section. All fs work happens in a per-test
 * temp directory acting as the repo root.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSkillsSection, discoverSkills, loadSkill, parseSkillDescription } from '../chat-skills'

let repoRoot: string

const addSkill = async (name: string, content: string, extraFiles: Record<string, string> = {}): Promise<void> => {
  const dir = join(repoRoot, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8')
  for (const [file, body] of Object.entries(extraFiles)) {
    await writeFile(join(dir, file), body, 'utf8')
  }
}

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'chat-skills-'))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

describe('parseSkillDescription', () => {
  it('extracts the description field from frontmatter', () => {
    expect(parseSkillDescription('---\nname: x\ndescription: Do the thing.\n---\nbody')).toBe('Do the thing.')
  })

  it('strips surrounding quotes', () => {
    expect(parseSkillDescription('---\ndescription: "Quoted."\n---\n')).toBe('Quoted.')
  })

  it('returns empty string when frontmatter or the field is missing', () => {
    expect(parseSkillDescription('no frontmatter here')).toBe('')
    expect(parseSkillDescription('---\nname: x\n---\n')).toBe('')
  })

  it('caps very long descriptions', () => {
    const long = 'a'.repeat(1000)
    const parsed = parseSkillDescription(`---\ndescription: ${long}\n---\n`)
    expect(parsed.length).toBeLessThan(450)
    expect(parsed.endsWith('…')).toBe(true)
  })
})

describe('discoverSkills', () => {
  it('returns [] when the skills directory does not exist', async () => {
    expect(await discoverSkills(repoRoot)).toEqual([])
  })

  it('lists skills sorted by name with their descriptions', async () => {
    await addSkill('task', '---\nname: task\ndescription: Enqueue a task.\n---\n')
    await addSkill('diagnose', '---\nname: diagnose\ndescription: Diagnose a failure.\n---\n')
    expect(await discoverSkills(repoRoot)).toEqual([
      { name: 'diagnose', description: 'Diagnose a failure.' },
      { name: 'task', description: 'Enqueue a task.' },
    ])
  })

  it('skips directories without a SKILL.md', async () => {
    await mkdir(join(repoRoot, '.claude', 'skills', 'not-a-skill'), { recursive: true })
    await addSkill('task', '---\ndescription: d\n---\n')
    expect((await discoverSkills(repoRoot)).map((s) => s.name)).toEqual(['task'])
  })
})

describe('loadSkill', () => {
  it('returns the SKILL.md body plus bundled file names', async () => {
    await addSkill('grill', '---\ndescription: d\n---\nGrill hard.', { 'rubric.md': 'r' })
    const skill = await loadSkill(repoRoot, 'grill')
    expect(skill?.content).toContain('Grill hard.')
    expect(skill?.files).toEqual(['rubric.md'])
  })

  it('returns null for unknown skills', async () => {
    expect(await loadSkill(repoRoot, 'nope')).toBeNull()
  })

  it('rejects traversal and separator names outright', async () => {
    await addSkill('task', '---\ndescription: d\n---\n')
    expect(await loadSkill(repoRoot, '../secrets')).toBeNull()
    expect(await loadSkill(repoRoot, 'a/b')).toBeNull()
    expect(await loadSkill(repoRoot, '.hidden')).toBeNull()
  })
})

describe('buildSkillsSection', () => {
  it('is empty when there are no skills', () => {
    expect(buildSkillsSection([])).toBe('')
  })

  it('renders one line per skill', () => {
    const section = buildSkillsSection([
      { name: 'diagnose', description: 'Diagnose a failure.' },
      { name: 'task', description: 'Enqueue a task.' },
    ])
    expect(section).toContain('- diagnose: Diagnose a failure.')
    expect(section).toContain('- task: Enqueue a task.')
    expect(section).toContain('`skill` tool')
  })

  it('grill posture includes a retrieval gate that restricts code exploration to behavioral questions', () => {
    const section = buildSkillsSection([], 'grill')
    expect(section).not.toBe('')
    // Should mention the retrieval gate explicitly
    expect(section.toLowerCase()).toContain('retrieval')
    // Gate should distinguish behavioral questions from policy/terminology
    expect(section.toLowerCase()).toMatch(/code.*behav|behav.*code/)
    expect(section.toLowerCase()).toMatch(/policy|terminolog|rule/)
  })

  it('grill posture section is non-empty even with no skills', () => {
    const triage = buildSkillsSection([], 'triage')
    const grill = buildSkillsSection([], 'grill')
    expect(triage).toBe('')
    expect(grill).not.toBe('')
  })
})
