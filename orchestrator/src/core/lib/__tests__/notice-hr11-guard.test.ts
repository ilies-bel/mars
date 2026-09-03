/**
 * HR-11 guard for notice renders.
 *
 * Scans every AutonomousNoticeKind's render output for second-person
 * evaluative language that attributes the operator's method, preventing
 * future HR-11 violations (DEC-20) the same way action-queue-jargon-ban.test.ts
 * guards §7 legibility.
 *
 * A failing test prints a message like:
 *   Notice "observation.manual-push" render contains banned pattern "habit"
 */

import { describe, expect, it } from 'vitest'
import {
  AutonomousNoticeKindSchema,
  renderConversationNotice,
  type AutonomousNoticeKind,
  type AutonomousNoticePayloads,
} from '../conversation-copy.js'

// ── Banned patterns ───────────────────────────────────────────────────────────

/**
 * Second-person evaluative language that must not appear in notice renders.
 * These patterns flag copy that judges the operator's method rather than
 * reporting a repo-state fact.
 */
const BANNED_PATTERNS: Array<{ term: string; regex: RegExp }> = [
  { term: 'outside the pipeline',       regex: /outside the pipeline/i },
  { term: 'habit',                       regex: /\bhabit\b/i },
  { term: 'second-person method attribution',
                                         regex: /\byou\b.{0,30}\b(skipped|chose|decided|landed|pushed|bypassed)\b/i },
  { term: 'accusation',                  regex: /\baccus/i },
  { term: 'cannot vouch',               regex: /cannot vouch/i },
]

// ── Representative payloads ───────────────────────────────────────────────────

/**
 * One realistic payload per kind, reusing fixtures from conversation-copy.test.ts.
 * Typed as the full payload map so a new kind fails to compile here until it
 * is given a fixture — kind list and this table can never drift silently.
 */
const REPRESENTATIVE_PAYLOADS: { [K in AutonomousNoticeKind]: AutonomousNoticePayloads[K] } = {
  'recipe.auto-applied': {
    recipeId: 'recipe-1',
    failureKind: 'verify-failed',
    targetTaskId: 'task-1',
  },
  'failure.batch': {
    taskCount: 2,
    cause: 'task branch has no commits ahead of integration',
  },
  'session.idle-proposal': { proposalId: 'prop-1', title: 'Rework the merge gate' },
  'suggestion.codegraph': { tasksRun: 41, windowDays: 7 },
  'observation.manual-push': { commits: 6, marsCommits: 665, windowDays: 14, branch: 'main' },
  'trend.token-spend': { changePct: 38, windowDays: 14 },
  'gate.main-broken': { failingCheck: 'npm test', blockedTasks: 4 },
  'merge.operator-auto-commit': {
    taskId: 'mars-abc123',
    branch: 'main',
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    files: ['operator.txt', 'notes.md'],
  },
  'steward.prompt-optimizer-ack': {
    workerId: 'Coder',
    reason: 'the depth ratio showed excess boilerplate',
    entryId: 'entry-abc123',
  },
  'steward.workflow-patch': {
    proposalId: 'prop-xyz789',
    workflowPath: '.mars/workflows/implement.md',
    summary: 'speed up the triage handoff step',
  },
}

// ── Helper ────────────────────────────────────────────────────────────────────

const assertNoBannedPatterns = (kind: AutonomousNoticeKind, text: string): void => {
  for (const { term, regex } of BANNED_PATTERNS) {
    expect(
      text,
      `Notice "${kind}" render contains banned pattern "${term}"`,
    ).not.toMatch(regex)
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('notice HR-11 guard — no evaluative language in renders', () => {
  it.each([...AutonomousNoticeKindSchema.options])(
    'kind "%s" render contains no banned patterns',
    (kind) => {
      const text = renderConversationNotice(kind, REPRESENTATIVE_PAYLOADS[kind])
      assertNoBannedPatterns(kind, text)
    },
  )

  it('meta: banned patterns are not vacuous', () => {
    const probe = 'you skipped verify outside the pipeline'
    const matchingPatterns = BANNED_PATTERNS.filter(({ regex }) => regex.test(probe))
    expect(
      matchingPatterns.length,
      'at least one banned pattern must match the probe string "you skipped verify outside the pipeline"',
    ).toBeGreaterThan(0)
  })
})
