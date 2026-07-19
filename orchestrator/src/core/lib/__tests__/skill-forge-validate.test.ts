import { describe, expect, it } from 'vitest'
import { validateSkillAgainstArc } from '../skill-forge-validate'
import type { DeepReflectRow } from '../skill-forge-detector'

// ── Fixtures ──

/** A SKILL.md where the description trigger is "structured tasks, task spec" */
const SKILL_STRUCTURED_TASKS = `---
name: use-structured-tasks-for-clarity
description: Always emit structured task specs when enqueueing work to reduce ambiguity. Use when the user mentions: structured tasks, task spec, emit spec.
---

# Use Structured Tasks for Clarity

Always emit structured task specs when enqueueing work to reduce ambiguity.
`

/** A SKILL.md whose trigger is "peer review, code review" */
const SKILL_CODE_REVIEW = `---
name: request-peer-review
description: Pair on changes before merging. Use when the user mentions: peer review, code review.
---

# Request Peer Review

Pair on changes before merging to catch subtle bugs.
`

function mkRow(originId: string, summary: string): DeepReflectRow {
  return { originId, title: 'Some title', rootCauseKey: 'some_key', summary }
}

// ── Tests ──

describe('validateSkillAgainstArc', () => {
  it('returns applies when an arc summary mentions a trigger keyword', () => {
    const arcRows: DeepReflectRow[] = [
      mkRow('arc-1', 'We should always emit structured tasks so agents have clear specs.'),
    ]
    const result = validateSkillAgainstArc(SKILL_STRUCTURED_TASKS, arcRows)
    expect(result.verdict).toBe('applies')
    expect(result.evidence).toContain('structured task')
  })

  it('returns misses when no arc summary mentions any trigger keyword', () => {
    const arcRows: DeepReflectRow[] = [
      mkRow('arc-1', 'We need to improve monitoring and alerting infrastructure.'),
      mkRow('arc-1', 'Logs should be shipped to a central aggregator for analysis.'),
    ]
    const result = validateSkillAgainstArc(SKILL_STRUCTURED_TASKS, arcRows)
    expect(result.verdict).toBe('misses')
    expect(result.evidence).toMatch(/no arc row conclusion mentions any of/)
  })

  it('matches any of multiple trigger keywords (second keyword hit)', () => {
    const arcRows: DeepReflectRow[] = [
      mkRow('arc-2', 'Operators should mandate a peer review step before merging PRs.'),
    ]
    const result = validateSkillAgainstArc(SKILL_CODE_REVIEW, arcRows)
    expect(result.verdict).toBe('applies')
  })

  it('evidence snippet is the matching row summary (truncated at 120 chars for long summaries)', () => {
    const longSummary =
      'Emitting a task spec up front clarifies the work and makes the agent more effective. ' +
      'Without a spec the agent has to guess the requirements, which leads to rework and wasted cycles.'
    const arcRows: DeepReflectRow[] = [mkRow('arc-3', longSummary)]
    const result = validateSkillAgainstArc(SKILL_STRUCTURED_TASKS, arcRows)
    expect(result.verdict).toBe('applies')
    expect(result.evidence.length).toBeLessThanOrEqual(124) // 120 chars + "…"
  })

  it('returns misses with diagnostic evidence for empty arc rows', () => {
    const result = validateSkillAgainstArc(SKILL_STRUCTURED_TASKS, [])
    expect(result.verdict).toBe('misses')
    expect(result.evidence).toMatch(/no arc row conclusion mentions any of/)
  })

  it('returns misses with diagnostic when skill has no parseable description', () => {
    const bareMarkdown = '# A Skill\n\nSome body text without frontmatter.'
    const arcRows: DeepReflectRow[] = [
      mkRow('arc-1', 'structured tasks are great'),
    ]
    const result = validateSkillAgainstArc(bareMarkdown, arcRows)
    expect(result.verdict).toBe('misses')
    expect(result.evidence).toContain('no trigger keywords could be parsed')
  })

  it('matching is case-insensitive', () => {
    const arcRows: DeepReflectRow[] = [
      mkRow('arc-1', 'STRUCTURED TASKS are the recommended way to enqueue work.'),
    ]
    const result = validateSkillAgainstArc(SKILL_STRUCTURED_TASKS, arcRows)
    expect(result.verdict).toBe('applies')
  })
})
