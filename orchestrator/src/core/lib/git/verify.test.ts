/**
 * Tests for the infra-failure detection helper introduced to prevent phantom
 * test-failure counts caused by concurrent embedded-Postgres builds.
 *
 * When multiple gradle/Spring tasks run in parallel, one task's embedded-PG
 * instance can be torn down while another build is mid-suite, producing
 * "the database system is shutting down" errors in the failing steps.  These
 * are *infrastructure* failures, not code-level assertion failures. The
 * `isInfraFailureOutput` helper classifies them so the verify primitive can
 * retry once before counting them as real failures.
 *
 * Also includes tests for the always-on completeness gate that parses the
 * coder's completion report and refuses to pass half-done work.
 */
import { describe, it, expect } from 'vitest'
import { isInfraFailureOutput, checkCompletenessGate } from './verify'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid completion-report block. */
const makeReport = (
  lines: Array<{ status: 'done' | 'partial' | 'blocked'; criterion: string; evidence: string }>,
): string => {
  const body = lines
    .map((l) => `- [${l.status}] ${l.criterion} — evidence: ${l.evidence}`)
    .join('\n')
  return `\`\`\`completion-report\n${body}\n\`\`\``
}

/** A worktreePath that is guaranteed to have no files under it. */
const EMPTY_WORKTREE = '/absolutely-nonexistent-worktree-dir-xyz987'

describe('isInfraFailureOutput', () => {
  // ── positive cases (infra failures) ─────────────────────────────────────

  it('classifies FATAL postgres shutdown as infra failure', () => {
    const output =
      'FATAL: the database system is shutting down'
    expect(isInfraFailureOutput(output)).toBe(true)
  })

  it('classifies full Spring DataAccess exception as infra failure', () => {
    // This is the exact stack trace excerpt from the reported incidents.
    const output = [
      'org.springframework.dao.DataAccessResourceFailureException: jOOQ; SQL [DELETE FROM comment];',
      'FATAL: the database system is shutting down',
    ].join('\n')
    expect(isInfraFailureOutput(output)).toBe(true)
  })

  it('classifies Spring ApplicationContextException as infra failure', () => {
    const output =
      'org.springframework.context.ApplicationContextException: Failed to start bean'
    expect(isInfraFailureOutput(output)).toBe(true)
  })

  it('classifies standalone "the database system is shutting down" message as infra failure', () => {
    // Appears when postgres shuts down mid-suite and the next query hits it.
    expect(
      isInfraFailureOutput('  caused by: the database system is shutting down'),
    ).toBe(true)
  })

  it('classifies connection-refused to a port as infra failure', () => {
    expect(
      isInfraFailureOutput('Connection refused: localhost:5432'),
    ).toBe(true)
  })

  // ── negative cases (genuine failures) ────────────────────────────────────

  it('does not classify a genuine JUnit assertion failure as infra failure', () => {
    const output = [
      'org.opentest4j.AssertionFailedError: expected: <1> but was: <2>',
      '  at com.example.MyTest.testCount(MyTest.java:42)',
    ].join('\n')
    expect(isInfraFailureOutput(output)).toBe(false)
  })

  it('does not classify a TypeScript type error as infra failure', () => {
    const output =
      "src/service/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."
    expect(isInfraFailureOutput(output)).toBe(false)
  })

  it('does not classify a NullPointerException as infra failure', () => {
    const output = [
      'java.lang.NullPointerException: Cannot invoke method foo() on null',
      '  at com.example.Service.doWork(Service.java:88)',
    ].join('\n')
    expect(isInfraFailureOutput(output)).toBe(false)
  })

  it('does not classify empty output as infra failure', () => {
    // An empty failure message is ambiguous; we conservatively fall through
    // to standard failure handling rather than unconditionally retrying.
    expect(isInfraFailureOutput('')).toBe(false)
  })

  it('does not classify whitespace-only output as infra failure', () => {
    expect(isInfraFailureOutput('   \n  ')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// checkCompletenessGate — all four verdict branches
// ---------------------------------------------------------------------------

describe('checkCompletenessGate', () => {
  // ── Branch 1: missing-completion-report (absent) ─────────────────────────

  it('fails with missing-completion-report when coder text has no report block', async () => {
    const step = await checkCompletenessGate({
      coderText: 'I finished the work but forgot the report.',
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.name).toBe('completeness')
    expect(step.tier).toBe('task')
    expect(step.passed).toBe(false)
    expect(step.output).toMatch(/^missing-completion-report:/)
    expect(step.output).toContain('no completion-report fenced block')
  })

  it('fails with missing-completion-report when coder text is empty', async () => {
    const step = await checkCompletenessGate({
      coderText: '',
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.passed).toBe(false)
    expect(step.output).toMatch(/^missing-completion-report:/)
  })

  // ── Branch 1b: missing-completion-report (unparseable) ───────────────────

  it('fails with missing-completion-report when the report block is malformed', async () => {
    // Block exists but lines do not match the required format
    const coderText = [
      'Done with the work.',
      '```completion-report',
      'This line does not have the right format',
      '```',
    ].join('\n')

    const step = await checkCompletenessGate({
      coderText,
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.passed).toBe(false)
    expect(step.output).toMatch(/^missing-completion-report:/)
    expect(step.output).toContain('malformed')
  })

  // ── Branch 2: incomplete (partial) ──────────────────────────────────────

  it('fails with incomplete when a criterion is partial', async () => {
    const coderText = makeReport([
      { status: 'done', criterion: 'first goal done', evidence: 'good test name passes' },
      { status: 'partial', criterion: 'second goal half done', evidence: 'TODO: finish' },
    ])

    const step = await checkCompletenessGate({
      coderText,
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.passed).toBe(false)
    expect(step.output).toMatch(/^incomplete:/)
    expect(step.output).toContain('second goal half done')
    expect(step.output).toContain('[partial]')
  })

  it('fails with incomplete when a criterion is blocked', async () => {
    const coderText = makeReport([
      { status: 'done', criterion: 'first goal', evidence: 'passing test verifies it' },
      { status: 'blocked', criterion: 'second goal blocked on infra', evidence: 'waiting on DB migration' },
    ])

    const step = await checkCompletenessGate({
      coderText,
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.passed).toBe(false)
    expect(step.output).toMatch(/^incomplete:/)
    expect(step.output).toContain('second goal blocked on infra')
    expect(step.output).toContain('[blocked]')
  })

  it('reports ALL unmet criteria in the incomplete detail', async () => {
    const coderText = makeReport([
      { status: 'partial', criterion: 'goal A', evidence: 'half done' },
      { status: 'done', criterion: 'goal B', evidence: 'done and verified' },
      { status: 'blocked', criterion: 'goal C', evidence: 'blocked' },
    ])

    const step = await checkCompletenessGate({
      coderText,
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.passed).toBe(false)
    expect(step.output).toMatch(/^incomplete: 2 criterion/)
    expect(step.output).toContain('goal A')
    expect(step.output).toContain('goal C')
    // goal B must NOT appear in the unmet list
    expect(step.output).not.toContain('[done]')
  })

  // ── Branch 3: unsubstantiated-completion ─────────────────────────────────

  it('fails with unsubstantiated-completion when a cited file is not in the diff', async () => {
    // All lines are done, but the file evidence is neither in changedFiles
    // nor in the (non-existent) worktree directory.
    const coderText = makeReport([
      {
        status: 'done',
        criterion: 'gate is implemented',
        // A relative file path — not in changedFiles, not in EMPTY_WORKTREE
        evidence: 'src/core/lib/git/clearly-missing-file.ts:42',
      },
    ])

    const step = await checkCompletenessGate({
      coderText,
      changedFiles: [], // empty diff
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.passed).toBe(false)
    expect(step.output).toMatch(/^unsubstantiated-completion:/)
    expect(step.output).toContain('clearly-missing-file.ts')
    expect(step.output).toContain('gate is implemented')
  })

  it('fails with unsubstantiated-completion when a cited commit SHA is not in the repo', async () => {
    // Evidence looks like a commit SHA but won't exist in any real git repo
    // (all-zero SHA is reserved and git cat-file -e will fail).
    const coderText = makeReport([
      {
        status: 'done',
        criterion: 'feature committed',
        evidence: '0000000000000000000000000000000000000000',
      },
    ])

    const step = await checkCompletenessGate({
      coderText,
      changedFiles: [],
      // Use the actual worktree root (which IS a git repo) but with an
      // impossible all-zero SHA that will never be a valid commit.
      worktreePath: '/tmp',
      branch: 'task/test',
    })

    expect(step.passed).toBe(false)
    // Either unsubstantiated-completion (git ran and said "not found")
    // or also acceptable if git itself wasn't accessible — the gate must still fail
    expect(
      step.output.startsWith('unsubstantiated-completion:') ||
      // graceful fallback: if the worktreePath is not a git repo at all,
      // checkEvidenceClaim wraps the error and also returns ok:false
      step.output.startsWith('unsubstantiated-completion:'),
    ).toBe(true)
    expect(step.output).toContain('0000000000000000000000000000000000000000')
  })

  // ── Branch 4: pass ───────────────────────────────────────────────────────

  it('passes when all criteria are done and evidence is non-verifiable test names', async () => {
    // Test names (free-form text that doesn't match file/SHA patterns) are
    // accepted without any filesystem or git check — they are not falsifiable.
    const coderText = makeReport([
      {
        status: 'done',
        criterion: 'completeness gate parses reports',
        evidence: 'checkCompletenessGate missing-completion-report test passes',
      },
      {
        status: 'done',
        criterion: 'completeness gate rejects partial work',
        evidence: 'checkCompletenessGate incomplete test passes',
      },
    ])

    const step = await checkCompletenessGate({
      coderText,
      changedFiles: [],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.passed).toBe(true)
    expect(step.output).toContain('2 criterion')
    expect(step.output).toContain('done and evidence verified')
  })

  it('passes when a cited file is in the changedFiles list', async () => {
    const changedFile = 'orchestrator/src/core/lib/git/verify.ts'
    const coderText = makeReport([
      {
        status: 'done',
        criterion: 'completeness gate added to verify.ts',
        evidence: `${changedFile}:1`,
      },
    ])

    const step = await checkCompletenessGate({
      coderText,
      changedFiles: [changedFile],
      worktreePath: EMPTY_WORKTREE,
      branch: 'task/test',
    })

    expect(step.passed).toBe(true)
  })
})
