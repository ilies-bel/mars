/**
 * Acceptance tests for the grill skill convergence rule.
 *
 * The grill skill was observed asking an unbounded sequence of questions,
 * including implementation-level details that the implementor should decide.
 * These tests verify the skill's SKILL.md carries an explicit convergence
 * rule so grilling terminates on its own:
 *
 *   - A question earns another turn only if answering it differently would
 *     change *what gets built*, not how it looks.
 *   - Implementation-level choices go into the task prompt as open choices,
 *     not as blocking questions to the user.
 *   - The skill declares a concrete stopping condition rather than relying on
 *     a "felt sense" of settlement.
 *
 * Both the live skill (.claude/skills/grill/SKILL.md) and the bundled
 * template (orchestrator/src/init/templates/claude/skills/grill/SKILL.md)
 * are checked so divergence is caught early.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Paths to both skill copies that must stay in sync.
const TEMPLATE_SKILL_PATH = resolve(
  __dirname,
  '..',
  'templates',
  'claude',
  'skills',
  'grill',
  'SKILL.md',
)

const LIVE_SKILL_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '.claude',
  'skills',
  'grill',
  'SKILL.md',
)

function readSkill(path: string): string {
  return readFileSync(path, 'utf8')
}

// ---------------------------------------------------------------------------
// Convergence rule: a question earns another turn only if its answer would
// change what gets built.
// ---------------------------------------------------------------------------

describe('grill SKILL.md (bundled template): convergence rule', () => {
  it('states that a question earns another turn only when answering it differently would change what gets built', () => {
    const content = readSkill(TEMPLATE_SKILL_PATH)
    // The rule must be present in some form — check for key phrase.
    expect(content).toMatch(/what gets built/i)
  })

  it('distinguishes load-bearing decisions from implementation details', () => {
    const content = readSkill(TEMPLATE_SKILL_PATH)
    expect(content).toMatch(/implementation.{0,20}detail/i)
  })

  it('says implementation-level choices belong in the task prompt as open choices, not blocking questions', () => {
    const content = readSkill(TEMPLATE_SKILL_PATH)
    // Must instruct the skill to park details in the task, not ask the user.
    expect(content).toMatch(/open choice/i)
  })

  it('carries an explicit stopping condition that does not rely solely on felt sense', () => {
    const content = readSkill(TEMPLATE_SKILL_PATH)
    // The "When to stop" section must name the convergence rule explicitly.
    const whenToStop = content.match(/## When to stop[\s\S]*?(?=\n##\s|\n# |$)/i)
    expect(whenToStop).not.toBeNull()
    const section = whenToStop![0]
    // The section must reference the "what gets built" test.
    expect(section).toMatch(/what gets built/i)
  })

  it('instructs the skill to file without being pushed once converged', () => {
    const content = readSkill(TEMPLATE_SKILL_PATH)
    // Must say to stop and file when the grill is converged, not wait for user prompting.
    expect(content).toMatch(/without being (asked|pushed|told|prompted)/i)
  })
})

// ---------------------------------------------------------------------------
// Same rules apply to the live skill file.
// ---------------------------------------------------------------------------

describe('grill SKILL.md (live .claude/skills): convergence rule', () => {
  it('states that a question earns another turn only when answering it differently would change what gets built', () => {
    const content = readSkill(LIVE_SKILL_PATH)
    expect(content).toMatch(/what gets built/i)
  })

  it('distinguishes load-bearing decisions from implementation details', () => {
    const content = readSkill(LIVE_SKILL_PATH)
    expect(content).toMatch(/implementation.{0,20}detail/i)
  })

  it('says implementation-level choices belong in the task prompt as open choices, not blocking questions', () => {
    const content = readSkill(LIVE_SKILL_PATH)
    expect(content).toMatch(/open choice/i)
  })

  it('carries an explicit stopping condition that does not rely solely on felt sense', () => {
    const content = readSkill(LIVE_SKILL_PATH)
    const whenToStop = content.match(/## When to stop[\s\S]*?(?=\n##\s|\n# |$)/i)
    expect(whenToStop).not.toBeNull()
    const section = whenToStop![0]
    expect(section).toMatch(/what gets built/i)
  })

  it('instructs the skill to file without being pushed once converged', () => {
    const content = readSkill(LIVE_SKILL_PATH)
    expect(content).toMatch(/without being (asked|pushed|told|prompted)/i)
  })
})

// ---------------------------------------------------------------------------
// The two files must stay in sync (same content).
// ---------------------------------------------------------------------------

describe('grill SKILL.md: template and live copy stay in sync', () => {
  it('bundled template and live skill have identical content', () => {
    const template = readFileSync(TEMPLATE_SKILL_PATH)
    const live = readFileSync(LIVE_SKILL_PATH)
    expect(template.equals(live)).toBe(true)
  })
})
