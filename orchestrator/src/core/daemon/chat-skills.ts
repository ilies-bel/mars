/**
 * Skill discovery for the chat agent.
 *
 * Skills are the repo's `.claude/skills/<name>/SKILL.md` runbooks (the same
 * files Claude Code loads for slash commands). The chat agent receives an
 * index of available skills appended to its instructions and loads a skill's
 * full instructions on demand via the `skill` function tool — mirroring the
 * deferred-skill pattern so the base context stays small.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SkillInfo {
  name: string
  description: string
}

/** Loaded skill: the SKILL.md body plus any bundled files in the skill dir. */
export interface LoadedSkill {
  content: string
  files: string[]
}

/**
 * Valid skill directory names. Rejects path separators and leading dots so a
 * model-supplied name can never traverse outside `.claude/skills/`.
 */
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i

/** Cap on the per-skill description line injected into the instructions. */
const DESCRIPTION_CHAR_CAP = 400

/**
 * Extract the `description:` value from a SKILL.md YAML frontmatter block.
 * Single-line values only (which is what the skill format uses); surrounding
 * quotes are stripped. Returns '' when the frontmatter or field is absent.
 */
export const parseSkillDescription = (content: string): string => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  if (!fm) return ''
  const line = fm[1].split('\n').find((l) => l.startsWith('description:'))
  if (!line) return ''
  const value = line.slice('description:'.length).trim().replace(/^["']|["']$/g, '')
  return value.length > DESCRIPTION_CHAR_CAP ? `${value.slice(0, DESCRIPTION_CHAR_CAP)}…` : value
}

/**
 * List the skills available under `<repoRoot>/.claude/skills`. A directory
 * counts as a skill only when it contains a readable SKILL.md. Returns []
 * when the skills directory itself is missing.
 */
export const discoverSkills = async (repoRoot: string): Promise<SkillInfo[]> => {
  const dir = join(repoRoot, '.claude', 'skills')
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: SkillInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const content = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8')
      skills.push({ name: entry.name, description: parseSkillDescription(content) })
    } catch {
      // No readable SKILL.md → not a skill.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Load one skill by name: the full SKILL.md body plus the relative paths of
 * any bundled files in the skill directory. Returns null for unknown or
 * invalid names (including anything that could escape the skills dir).
 */
export const loadSkill = async (repoRoot: string, name: string): Promise<LoadedSkill | null> => {
  if (!SKILL_NAME_RE.test(name)) return null
  const dir = join(repoRoot, '.claude', 'skills', name)
  try {
    const content = await readFile(join(dir, 'SKILL.md'), 'utf8')
    const entries = await readdir(dir, { recursive: true })
    const files = entries.filter((f) => f !== 'SKILL.md').sort()
    return { content, files }
  } catch {
    return null
  }
}

/**
 * Render the skill index appended to the chat instructions. Empty string when
 * no skills are available in triage; grill posture retains its instructions
 * even when this repo has no discoverable skills.
 */
export const buildSkillsSection = (skills: readonly SkillInfo[], posture: 'triage' | 'grill' = 'triage'): string => {
  const lines = [
    'Skills: reusable runbooks for common Mars operations. When a request',
    'matches one, call the `skill` tool with its name FIRST and follow the',
    'loaded instructions for the rest of the turn. Available skills:',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ]
  if (posture === 'grill') {
    lines.push(
      'Grill posture is active: use the glossary, ADR, and PRD tools when the conversation reaches those decisions.',
      'Retrieval gate: reach for code-exploration tools (codegraph, shell file reads) ONLY when the turn requires knowing how the code actually behaves right now — e.g. "does the current implementation do X?" or "where is Y defined?". Policy questions, terminology decisions, and "what should we do?" turns need only the glossary, prior ADRs, and the conversation so far. Never call codegraph_explore to answer a rule or choose a term.',
    )
  }
  return skills.length > 0 || posture === 'grill' ? lines.join('\n') : ''
}
