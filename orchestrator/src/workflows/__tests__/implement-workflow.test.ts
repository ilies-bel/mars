import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  COMMIT_FOOTER,
  CODING_DISCIPLINE,
  BLOCKERS_ABORT_MESSAGE,
  DIRTY_MAIN_SETUP_MESSAGE,
  DEVIATION_RULES,
  TOO_HARD_ABORT_MESSAGE,
  composePrompt,
  detectPostCoderState,
  failureExcerpt,
  isBlockersAbortError,
  isDirtyMainSetupError,
  isTooHardAbortError,
  resolveWorkerSystemPrompt,
  shouldWireReadSpanWatcher,
} from '../implement-workflow'
import { CONTEXT_GATHERING_BRIEF } from '../context-gathering-brief'
import { buildDiagnoseChorePrompt } from '../../mastra/lib/diagnose-chore'
import { resolveReadSpanLimit, createReadSpanWatcher } from '../../mastra/lib/read-span-watch'
import type { ReadSpanTrace } from '../../mastra/lib/read-span-watch'
import { RequestContext } from '@mastra/core/di'
import { createLibsqlTaskStore } from '../../mastra/lib/task-store'
import { createClient } from '@libsql/client'

describe('composePrompt — coder default', () => {
  it('appends the commit footer to a bare prompt', () => {
    const out = composePrompt('do the thing', null)
    expect(out.endsWith(COMMIT_FOOTER)).toBe(true)
    expect(out.startsWith('do the thing')).toBe(true)
  })

  it('appends the commit footer after the plan sections', () => {
    const out = composePrompt('do the thing', {
      functional: 'F',
      technical: 'T',
    })
    expect(out.endsWith(COMMIT_FOOTER)).toBe(true)
    const fIdx = out.indexOf('## Functional plan')
    const tIdx = out.indexOf('## Technical plan')
    const cIdx = out.indexOf(COMMIT_FOOTER)
    expect(fIdx).toBeGreaterThan(-1)
    expect(tIdx).toBeGreaterThan(fIdx)
    expect(cIdx).toBeGreaterThan(tIdx)
  })

  it('mentions git add and git commit explicitly', () => {
    expect(COMMIT_FOOTER).toContain('git add')
    expect(COMMIT_FOOTER).toContain('git commit')
  })

  it('names no-commits-ahead only as the consequence of the agent failing to commit', () => {
    // The footer must link the verify:has-diff/no-commits-ahead signature to
    // the agent not having committed — not to some other cause such as
    // dirty-main. The phrase "agent did not commit" is the required signal.
    expect(COMMIT_FOOTER).toContain('verify:has-diff/no-commits-ahead')
    expect(COMMIT_FOOTER).toContain('agent did not commit')
  })

  it('explicitly distinguishes dirty-main as a separate, operator-owned failure mode', () => {
    // The footer must name verify:dirty-main and attribute it to the operator,
    // so the agent cannot truthfully blame dirty-main on itself after reading
    // the footer.
    expect(COMMIT_FOOTER).toContain('verify:dirty-main')
    expect(COMMIT_FOOTER).toMatch(/operator-owned/i)
    expect(COMMIT_FOOTER).toMatch(/not your responsibility/i)
  })

  it('defaults to the coder footer when no tag is supplied', () => {
    const out = composePrompt('do the thing', null)
    expect(out).toContain('git add')
    expect(out).not.toContain('mars glossary set')
  })

  it('does NOT include the deviation-rules text in the coder task prompt', () => {
    const out = composePrompt('do the thing', null)
    expect(out).not.toContain('## Deviation rules')
  })
})

// The 'composePrompt — writer routing' describe block was removed by ADR 0019.
// The structured-write Writer lane no longer exists; every dispatched task
// uses the uniform Coder path (COMMIT_FOOTER, CODING_DISCIPLINE, diff gate).

describe('composePrompt — uniform commit-footer gate (ADR 0019)', () => {
  it('always ends with COMMIT_FOOTER regardless of input', () => {
    // The writer-footer escape hatch is removed; every task gets the commit
    // footer so the diff gate fires uniformly on every dispatched run.
    expect(composePrompt('do the thing', null).endsWith(COMMIT_FOOTER)).toBe(true)
    expect(composePrompt('do the thing', null, 'coder').endsWith(COMMIT_FOOTER)).toBe(true)
  })

  it('always includes CODING_DISCIPLINE regardless of input', () => {
    // Before ADR 0019, writer tasks skipped CODING_DISCIPLINE. Now every task
    // includes it — there is no special-case branch.
    expect(composePrompt('do the thing', null)).toContain('## Coding discipline')
    expect(composePrompt('do the thing', null, 'coder')).toContain('## Coding discipline')
  })
})

describe('shouldWireReadSpanWatcher — read-span guard exemption', () => {
  it("wires the watcher for an ordinary task (kind='task')", () => {
    // After ADR 0019 the tag parameter is gone — the watcher fires for every
    // dispatched run regardless of tag (since 'coder' is the only tag).
    expect(shouldWireReadSpanWatcher('task')).toBe(true)
  })

  it("wires the watcher for a recovery fix-task (kind='fix')", () => {
    expect(shouldWireReadSpanWatcher('fix')).toBe(true)
  })

  it("does NOT wire the watcher for a diagnose Chore (kind='diagnose')", () => {
    // PRD 06e677fb: heavy reading is the diagnose Chore's actual job;
    // its only backstop is the existing time/turn cap.
    expect(shouldWireReadSpanWatcher('diagnose')).toBe(false)
  })

  it('diagnose kind produces a null watcher at the call site — no abort can trigger regardless of read count', () => {
    // Replicates the exact conditional used in codeStep:
    //   const watcher = shouldWireReadSpanWatcher(kind) ? createReadSpanWatcher(...) : null
    // When kind='diagnose' the watcher is null; watcher?.thresholdEverReached is
    // undefined (falsy) so the guard branch `watcher?.thresholdEverReached && ...`
    // never fires no matter how many consecutive reads the agent issues.
    const watcher = shouldWireReadSpanWatcher('diagnose')
      ? createReadSpanWatcher({ limit: resolveReadSpanLimit(), onThreshold: () => {} })
      : null
    expect(watcher).toBeNull()
    expect(watcher?.thresholdEverReached).toBeUndefined()
  })

  it('ordinary task kind produces a live watcher that can trip the guard', () => {
    // Contrasting case: for kind='task' the watcher is non-null, meaning
    // the guard is active and consecutive reads will trip thresholdEverReached.
    // ClaudeEvent wraps tool uses inside message.content (assistant turn).
    const limit = 2
    const watcher = shouldWireReadSpanWatcher('task')
      ? createReadSpanWatcher({ limit, onThreshold: () => {} })
      : null
    expect(watcher).not.toBeNull()
    // Feed enough read events to exceed the limit (each is an assistant turn
    // with one Read tool_use block, matching what extractToolUses expects).
    const readEvent = {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/src/foo.ts' } }],
      },
    }
    for (let i = 0; i < limit + 1; i++) watcher!.observe(readEvent)
    expect(watcher!.thresholdEverReached).toBe(true)
  })
})

describe('composePrompt — diagnose Chore short-circuit', () => {
  it("returns the prompt verbatim when kind is 'diagnose' — no commit footer", () => {
    const prompt = '# Diagnose-only Chore for mars-aaaaaaaa\n\nbody'
    const out = composePrompt(
      prompt,
      null,
      'coder',
      null,
      'mars-aaaaaaaa',
      '/tmp/worktree',
      'diagnose',
    )
    expect(out).toBe(prompt.trim())
    expect(out).not.toContain(COMMIT_FOOTER)
  })

  it("does not inject the worktree orientation block when kind is 'diagnose'", () => {
    const prompt = '# Diagnose-only Chore for mars-aaaaaaaa'
    const out = composePrompt(
      prompt,
      { functional: 'F', technical: 'T' },
      'coder',
      { files: ['src/foo.ts'], verifyCmd: null, doneCriteria: [], taskType: 'auto' },
      'mars-aaaaaaaa',
      '/tmp/worktree',
      'diagnose',
    )
    expect(out).toBe(prompt.trim())
    expect(out).not.toContain('## Worktree orientation')
    expect(out).not.toContain('## Functional plan')
  })
})

describe('resolveWorkerSystemPrompt — uniform Coder standing instructions (ADR 0019)', () => {
  it('standing instructions contain the full deviation-rules text', () => {
    const prompt = resolveWorkerSystemPrompt('coder')
    expect(prompt).toContain('## Deviation rules')
    expect(prompt).toContain('do NOT quit silently')
  })

  it('DEVIATION_RULES is not injected as a standalone section — it is embedded in the system prompt', () => {
    const prompt = resolveWorkerSystemPrompt('coder')
    expect(prompt).toContain(DEVIATION_RULES)
  })

  it('every task tag resolves to the same Coder standing instructions (no writer branch)', () => {
    // The structured-write Writer system prompt was removed by ADR 0019.
    // resolveWorkerSystemPrompt now returns the Coder instructions for every tag.
    const coderPrompt = resolveWorkerSystemPrompt('coder')
    expect(coderPrompt).toContain('## Deviation rules')
    // Verify the function is deterministic and returns the coder prompt for every valid tag.
    expect(resolveWorkerSystemPrompt('coder')).toBe(coderPrompt)
  })
})

describe('resolveWorkerSystemPrompt — read-span guard budget in standing instructions', () => {
  afterEach(() => {
    delete process.env.MARS_READ_SPAN_LIMIT
  })

  it('coder standing instructions contain a read-span guard section', () => {
    delete process.env.MARS_READ_SPAN_LIMIT
    const instructions = resolveWorkerSystemPrompt('coder')!
    expect(instructions).toMatch(/Read.span guard/i)
  })

  it('the stated consecutive-read budget equals the configured guard limit (default 5)', () => {
    delete process.env.MARS_READ_SPAN_LIMIT
    const instructions = resolveWorkerSystemPrompt('coder')!
    const limit = resolveReadSpanLimit() // → 5 by default
    // The limit must appear in the read-span guard context, not incidentally.
    // Implementation embeds it as "**<limit>**" in the guard section.
    expect(instructions).toContain(`**${limit}**`)
  })

  it('overriding MARS_READ_SPAN_LIMIT changes the stated budget in the standing instructions', () => {
    process.env.MARS_READ_SPAN_LIMIT = '12'
    const instructions = resolveWorkerSystemPrompt('coder')!
    const limit = resolveReadSpanLimit() // → 12
    expect(limit).toBe(12)
    // The new limit must appear in the guard section.
    expect(instructions).toContain(`**${limit}**`)
    // The default (5) must NOT appear as the guard limit when overridden.
    expect(instructions).not.toContain('**5**')
  })

  it('every tag resolves to the same standing instructions including the read-span guard section', () => {
    // After ADR 0019 there is no writer-specific prompt without the guard.
    const instructions = resolveWorkerSystemPrompt('coder')
    expect(instructions).toMatch(/Read.span guard/i)
  })
})

describe('composePrompt — worktree orientation', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(resolve(tmpdir(), 'mars-compose-prompt-'))
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
  })

  const seedOrchestrator = (): string => {
    const sub = resolve(worktree, 'orchestrator')
    mkdirSync(sub)
    writeFileSync(
      resolve(sub, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    )
    writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
    return sub
  }

  it('emits the orientation block with the resolved project subdirectory before the spec block', () => {
    const sub = seedOrchestrator()
    const out = composePrompt(
      'do the thing',
      null,
      'coder',
      {
        files: ['orchestrator/src/foo.ts'],
        verifyCmd: 'npx vitest run',
        doneCriteria: ['it works'],
        taskType: 'auto',
      },
      'mars-test-123',
      worktree,
    )
    expect(out).toContain('## Worktree orientation')
    expect(out).toContain(`You are at worktree root: ${worktree}`)
    expect(out).toContain(`Project subdirectory for tests, typecheck, and build commands: ${sub}`)
    expect(out).toContain('cd orchestrator && <verifyCmd>')

    const orientationIdx = out.indexOf('## Worktree orientation')
    const specIdx = out.indexOf('## Structured-task contract')
    expect(orientationIdx).toBeGreaterThan(-1)
    expect(specIdx).toBeGreaterThan(orientationIdx)
  })

  it('uses the simpler root-only phrasing when taskCwd equals worktreeRoot', () => {
    // No subprojects seeded → resolveTaskCwd falls back to resolveVerifyCwd,
    // which returns the worktree root unchanged.
    const out = composePrompt(
      'do the thing',
      null,
      'coder',
      {
        files: ['.github/workflows/ci.yml', 'orchestrator/y.ts'],
        verifyCmd: null,
        doneCriteria: [],
        taskType: 'auto',
      },
      'mars-test-123',
      worktree,
    )
    expect(out).toContain('## Worktree orientation')
    expect(out).toContain(`You operate from this worktree root: ${worktree}`)
    expect(out).not.toContain('Project subdirectory for tests')
  })

  it('omits the orientation block entirely when worktreeRoot is not supplied (legacy callers)', () => {
    const out = composePrompt('do the thing', null)
    expect(out).not.toContain('## Worktree orientation')
  })
})

describe('composePrompt — coding discipline', () => {
  it('includes the coding discipline section in coder task prompts', () => {
    const out = composePrompt('do the thing', null)
    expect(out).toContain('## Coding discipline')
  })

  it('coding discipline section appears before the commit footer', () => {
    const out = composePrompt('do the thing', null)
    const disciplineIdx = out.indexOf('## Coding discipline')
    const footerIdx = out.indexOf(COMMIT_FOOTER)
    expect(disciplineIdx).toBeGreaterThan(-1)
    expect(footerIdx).toBeGreaterThan(disciplineIdx)
  })

  it('does NOT include coding discipline in diagnose prompts', () => {
    const prompt = '# Diagnose-only Chore'
    const out = composePrompt(prompt, null, 'coder', null, 'mars-test', '/tmp/wt', 'diagnose')
    expect(out).not.toContain('## Coding discipline')
  })

  it('CODING_DISCIPLINE names the no-single-caller-helpers rule', () => {
    expect(CODING_DISCIPLINE).toMatch(/single.caller/i)
  })

  it('CODING_DISCIPLINE names the test-observable-behaviour rule', () => {
    expect(CODING_DISCIPLINE).toMatch(/internal state/i)
  })

  it('CODING_DISCIPLINE names the cross-boundary verification rule', () => {
    expect(CODING_DISCIPLINE).toMatch(/cross.boundary|real.boundary|real binary/i)
  })
})

describe('detectPostCoderState', () => {
  let repo: string

  const initRepo = (): void => {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repo,
    })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'README'), 'hello\n')
    execFileSync('git', ['add', 'README'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', '-b', 'task/X', 'main'], {
      cwd: repo,
    })
  }

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-post-coder-state-'))
    initRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('does NOT flag a clean-no-work run (no diff, no commits) as dirty-no-commits', async () => {
    // Coder ran but produced nothing — tree is clean, branch tip equals
    // integration. The has-diff verify gate owns this failure; the new
    // guard must stay quiet here so the two signals don't double-fire.
    const result = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(result.kind).toBe('clean-no-work')
  })

  it('does NOT flag a clean-success run (commits present) as dirty-no-commits', async () => {
    writeFileSync(resolve(repo, 'real.ts'), 'export const ok = true\n')
    execFileSync('git', ['add', 'real.ts'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'feat: real work'], { cwd: repo })

    const result = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(result.kind).toBe('clean-with-commits')
    if (result.kind === 'clean-with-commits') {
      expect(result.commitsAhead).toBe(1)
    }
  })

  it('flags dirty-tree with zero commits ahead of integration as the guarded condition', async () => {
    // Simulate a coder that wrote files but never staged/committed them.
    writeFileSync(resolve(repo, 'untracked.ts'), 'export const wrong = true\n')
    mkdirSync(resolve(repo, 'src'), { recursive: true })
    writeFileSync(resolve(repo, 'src', 'also-untracked.ts'), 'x\n')

    const result = await detectPostCoderState({
      worktreePath: repo,
      integrationBranch: 'main',
    })

    expect(result.kind).toBe('dirty-no-commits')
    if (result.kind === 'dirty-no-commits') {
      expect(result.dirtyFiles).toEqual(
        expect.arrayContaining(['untracked.ts', 'src/also-untracked.ts']),
      )
    }
  })
})

describe('failureExcerpt — verify:test triage excerpt', () => {
  // Mimics a real vitest run: a long preamble of passing ✓ lines, then
  // the failure block + summary LAST. The persisted excerpt must surface
  // the tail (the actual signal), not the useless head.
  const preamble =
    'test: synced MARS_VERSION = 0.1.0\n RUN v2.1.9\n' +
    Array.from({ length: 200 }, (_, i) => ` ✓ src/foo-${i}.test.ts (3 tests)`).join('\n')
  const failureBlock =
    '\n FAIL src/bar.test.ts > does the thing\n' +
    'AssertionError: expected A to be B\n' +
    '- Expected\n+ Received\n' +
    '\nTest Files  1 failed | 200 passed (201)\n     Tests  1 failed | 600 passed (601)'
  const fullOutput = preamble + failureBlock

  it('keeps the failing assertion / FAIL summary tail, not solely the preamble', () => {
    const excerpt = failureExcerpt(fullOutput)
    expect(excerpt).toContain('FAIL src/bar.test.ts')
    expect(excerpt).toContain('AssertionError: expected A to be B')
    expect(excerpt).toContain('1 failed')
    // Regression guard (mars-fce65d26): the persisted excerpt must NOT
    // consist solely of the passing preamble — the failure block is the
    // whole point of triage.
    expect(excerpt).not.toBe(preamble)
  })

  it('also retains a small head so early spawn/import crashes survive', () => {
    const excerpt = failureExcerpt(fullOutput)
    // The early-crash signal lives at the very top of the run; the
    // head+tail mitigation must preserve it alongside the failure tail.
    expect(excerpt).toContain('synced MARS_VERSION = 0.1.0')
    expect(excerpt).toContain('…[middle elided]…')
  })

  it('returns short output verbatim (no elision marker)', () => {
    const short = 'FAIL src/x.test.ts\nAssertionError: nope'
    expect(failureExcerpt(short)).toBe(short)
    expect(failureExcerpt(short)).not.toContain('…[middle elided]…')
  })

  it('caps the excerpt near head+tail max (default ~3000 chars)', () => {
    const excerpt = failureExcerpt(fullOutput)
    expect(fullOutput.length).toBeGreaterThan(2000 + 1000)
    // head (≤1000) + tail (≤2000) + the elision marker
    expect(excerpt.length).toBeLessThanOrEqual(
      1000 + 2000 + '\n…[middle elided]…\n'.length,
    )
  })
})

describe('isBlockersAbortError — cause-chain robustness', () => {
  it('detects the bare throw-path sentinel', () => {
    expect(
      isBlockersAbortError(new Error(BLOCKERS_ABORT_MESSAGE('mars-abc'))),
    ).toBe(true)
  })

  it('does not false-positive on unrelated failures', () => {
    expect(isBlockersAbortError(new Error('verify command exited 1'))).toBe(
      false,
    )
    expect(isBlockersAbortError(null)).toBe(false)
    expect(isBlockersAbortError(undefined)).toBe(false)
  })

  it('is cycle-safe on a self-referential cause chain', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as { cause?: unknown }).cause = b
    expect(() => isBlockersAbortError(a)).not.toThrow()
    expect(isBlockersAbortError(a)).toBe(false)
  })
})

describe('isDirtyMainSetupError', () => {
  // setupStep throws `task <id> setup:preflight/dirty-main: <message>`; the
  // detector keys on the signature substring so the daemon can suppress the
  // misleading `task.completed status=failed` emit (the source is already
  // parked blocked with a real task_blockers edge).
  const thrown = (taskId: string): string =>
    `task ${taskId} setup:preflight/dirty-main: ${DIRTY_MAIN_SETUP_MESSAGE}`

  it('matches the dirty-main setup abort', () => {
    expect(isDirtyMainSetupError(new Error(thrown('mars-abc')))).toBe(true)
  })

  it('does not false-positive on unrelated errors', () => {
    expect(isDirtyMainSetupError(new Error('tsc failed: TS2304'))).toBe(false)
    expect(isDirtyMainSetupError(new Error('verify command exited 1'))).toBe(false)
    // The merge-time dirty-target failure is a different signature and must
    // NOT be swallowed by this detector.
    expect(
      isDirtyMainSetupError(new Error('merge:preflight/uncommitted-changes')),
    ).toBe(false)
    expect(isDirtyMainSetupError(null)).toBe(false)
    expect(isDirtyMainSetupError(undefined)).toBe(false)
  })

  it('matches when Mastra wraps the error on the cause chain', () => {
    const wrapped = new Error('Step setup-worktree failed', {
      cause: new Error(thrown('mars-xyz')),
    })
    expect(isDirtyMainSetupError(wrapped)).toBe(true)
  })

  it('does not match the blockers sentinel', () => {
    expect(isDirtyMainSetupError(new Error(BLOCKERS_ABORT_MESSAGE('mars-abc')))).toBe(false)
  })

  it('DIRTY_MAIN_SETUP_MESSAGE avoids the uncommitted-changes substring', () => {
    // Critical: the classifier rule for `dirty-main` must win over the
    // `uncommitted-changes` rule, which it only does if the message does
    // not contain "has uncommitted changes".
    expect(DIRTY_MAIN_SETUP_MESSAGE).not.toContain('has uncommitted changes')
  })
})

describe('resolveWorkerSystemPrompt — Explore-trust rule inside deviation-rules section', () => {
  it('coder system prompt contains the authoritative-orientation sentence', () => {
    const prompt = resolveWorkerSystemPrompt('coder')!
    expect(prompt).toContain(
      'When an Explore or general-purpose sub-agent returns a structured summary citing file paths and line numbers, treat that summary as authoritative orientation.',
    )
  })

  it('coder system prompt contains the TWO-follow-up-Reads phrase', () => {
    const prompt = resolveWorkerSystemPrompt('coder')!
    expect(prompt).toContain(
      'Proceed directly to an Edit or Write within at most TWO follow-up Reads, and only Read ranges the sub-agent did NOT cover.',
    )
  })

  it('coder system prompt contains the analysis-paralysis phrase', () => {
    const prompt = resolveWorkerSystemPrompt('coder')!
    expect(prompt).toContain(
      'Re-reading a file the sub-agent already summarised counts as analysis paralysis and trips the read-span watcher.',
    )
  })

  it('the Explore-trust rule sits inside DEVIATION_RULES, not as a standalone block', () => {
    expect(DEVIATION_RULES).toContain(
      'When an Explore or general-purpose sub-agent returns a structured summary citing file paths and line numbers, treat that summary as authoritative orientation.',
    )
    expect(DEVIATION_RULES).toContain(
      'Proceed directly to an Edit or Write within at most TWO follow-up Reads, and only Read ranges the sub-agent did NOT cover.',
    )
    expect(DEVIATION_RULES).toContain(
      'Re-reading a file the sub-agent already summarised counts as analysis paralysis and trips the read-span watcher.',
    )
  })

  // The Writer system prompt test was removed by ADR 0019 (Writer Worker no longer exists).
})

describe('buildCoderSystemPrompt — context-gathering discipline brief', () => {
  it('coder standing instructions contain the context-gathering discipline brief', () => {
    const instructions = resolveWorkerSystemPrompt('coder')!
    expect(instructions).toContain(CONTEXT_GATHERING_BRIEF)
  })

  it('brief appears after the read-span guard section and before the deviation rules section', () => {
    const instructions = resolveWorkerSystemPrompt('coder')!
    const readSpanGuardIdx = instructions.indexOf('## Read-span guard')
    const briefIdx = instructions.indexOf(CONTEXT_GATHERING_BRIEF)
    const deviationRulesIdx = instructions.indexOf(DEVIATION_RULES)

    expect(readSpanGuardIdx).toBeGreaterThan(-1)
    expect(briefIdx).toBeGreaterThan(readSpanGuardIdx)
    expect(deviationRulesIdx).toBeGreaterThan(briefIdx)
  })

  it('brief states the one-Explore-per-turn rule', () => {
    expect(CONTEXT_GATHERING_BRIEF).toMatch(/one.*Explore.*per.turn|at most one Explore/i)
  })

  it('brief states the no-re-Read-after-Explore rule', () => {
    expect(CONTEXT_GATHERING_BRIEF).toMatch(/do not Read.*Explore.*already|not.*re.Read.*after.*Explore/i)
  })

  it('brief states the Edit-intent escape hatch', () => {
    expect(CONTEXT_GATHERING_BRIEF).toMatch(/Edit/i)
    expect(CONTEXT_GATHERING_BRIEF).toMatch(/about to Edit|intent.*Edit|Edit.*escape/i)
  })

  it('brief states the sharper-follow-up guidance', () => {
    expect(CONTEXT_GATHERING_BRIEF).toMatch(/sharper|follow.up/i)
    expect(CONTEXT_GATHERING_BRIEF).toMatch(/Explore/i)
  })

  it('every dispatched task carries the context-gathering discipline brief (no exempt tag)', () => {
    // After ADR 0019 every tag resolves to the Coder standing instructions,
    // so the brief is present for all dispatched tasks.
    const instructions = resolveWorkerSystemPrompt('coder')
    expect(instructions).toContain(CONTEXT_GATHERING_BRIEF)
  })
})

describe('composePrompt — read-first and prescriptive-action sections', () => {
  it('renders <read_first> and <prescriptive_action> when the spec carries them', () => {
    const out = composePrompt(
      'implement the thing',
      null,
      'coder',
      {
        files: ['src/a.ts'],
        verifyCmd: 'npx tsc --noEmit',
        doneCriteria: ['types pass'],
        taskType: 'auto',
        readFirst: ['src/b.ts', 'src/c.ts'],
        prescriptiveAction: 'Call doSomething() in src/a.ts at line 42.',
      },
      'mars-test-rf',
    )
    expect(out).toContain('<read_first>')
    expect(out).toContain('src/b.ts')
    expect(out).toContain('src/c.ts')
    expect(out).toContain('<prescriptive_action>')
    expect(out).toContain('Call doSomething() in src/a.ts at line 42.')
  })

  it('preserves read-first list ordering: items appear numbered in producer order', () => {
    const out = composePrompt(
      'implement the thing',
      null,
      'coder',
      {
        files: ['src/a.ts'],
        verifyCmd: null,
        doneCriteria: [],
        taskType: 'auto',
        readFirst: ['first.ts', 'second.ts', 'third.ts'],
      },
      'mars-test-order',
    )
    const rfIdx = out.indexOf('<read_first>')
    expect(rfIdx).toBeGreaterThan(-1)
    const rfBlock = out.slice(rfIdx, out.indexOf('</read_first>') + 13)
    const firstIdx = rfBlock.indexOf('first.ts')
    const secondIdx = rfBlock.indexOf('second.ts')
    const thirdIdx = rfBlock.indexOf('third.ts')
    expect(firstIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(thirdIdx)
  })

  it('places read-first after files and before verify in the structured-task contract', () => {
    const out = composePrompt(
      'implement the thing',
      null,
      'coder',
      {
        files: ['src/a.ts'],
        verifyCmd: 'npx tsc --noEmit',
        doneCriteria: [],
        taskType: 'auto',
        readFirst: ['src/b.ts'],
        prescriptiveAction: 'do the thing',
      },
      'mars-test-order',
    )
    const filesIdx = out.indexOf('<files>')
    const rfIdx = out.indexOf('<read_first>')
    const paIdx = out.indexOf('<prescriptive_action>')
    const verifyIdx = out.indexOf('<verify>')
    expect(filesIdx).toBeGreaterThan(-1)
    expect(rfIdx).toBeGreaterThan(filesIdx)
    expect(paIdx).toBeGreaterThan(rfIdx)
    expect(verifyIdx).toBeGreaterThan(paIdx)
  })

  it('omits both new sections and leaves no extra whitespace when the spec has neither field', () => {
    const out = composePrompt(
      'implement the thing',
      null,
      'coder',
      {
        files: ['src/a.ts'],
        verifyCmd: 'npx tsc --noEmit',
        doneCriteria: ['types pass'],
        taskType: 'auto',
      },
      'mars-test-norf',
    )
    expect(out).not.toContain('<read_first>')
    expect(out).not.toContain('<prescriptive_action>')
    expect(out).not.toContain('read first')
  })

  it('omits both sections when spec has empty readFirst and null prescriptiveAction', () => {
    const out = composePrompt(
      'implement the thing',
      null,
      'coder',
      {
        files: ['src/a.ts'],
        verifyCmd: null,
        doneCriteria: [],
        taskType: 'auto',
        readFirst: [],
        prescriptiveAction: null,
      },
      'mars-test-empty',
    )
    expect(out).not.toContain('<read_first>')
    expect(out).not.toContain('<prescriptive_action>')
  })

  it('omits read-first section (only) when prescriptiveAction is set but readFirst is empty', () => {
    const out = composePrompt(
      'implement the thing',
      null,
      'coder',
      {
        files: ['src/a.ts'],
        verifyCmd: null,
        doneCriteria: [],
        taskType: 'auto',
        readFirst: [],
        prescriptiveAction: 'Do the thing now.',
      },
      'mars-test-paonly',
    )
    expect(out).not.toContain('<read_first>')
    expect(out).toContain('<prescriptive_action>')
    expect(out).toContain('Do the thing now.')
  })
})

describe('TaskStore context injection', () => {
  it('a TaskStore set on RequestContext is retrievable by the step execute pattern', () => {
    // This verifies the composition-root wiring: the daemon puts a TaskStore
    // into a RequestContext, which Mastra propagates to each step's execute
    // params. Steps extract it with the same cast the step code uses.
    const client = createClient({ url: ':memory:' })
    const store = createLibsqlTaskStore(client)
    const ctx = new RequestContext()
    ctx.set('taskStore', store)
    // Reproduce the exact extraction pattern used in each workflow step.
    const extracted = (ctx.get('taskStore') as typeof store | undefined) ?? null
    expect(extracted).toBe(store)
  })

  it('RequestContext.get returns undefined for an unset key, triggering the getDefaultTaskStore fallback', () => {
    const ctx = new RequestContext()
    const extracted = ctx.get('taskStore') as unknown
    // When no store is set, the step falls back to getDefaultTaskStore().
    // Here we just verify the get returns undefined/falsy so the ?? fallback fires.
    expect(extracted == null || extracted === undefined).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sentinel helpers for the read-span guard → diagnose Chore path
// ---------------------------------------------------------------------------

describe('isTooHardAbortError — read-span sentinel', () => {
  it('recognises the sentinel message emitted by the codeStep', () => {
    const err = new Error(TOO_HARD_ABORT_MESSAGE('mars-abc12345'))
    expect(isTooHardAbortError(err)).toBe(true)
  })

  it('does not false-positive on an unrelated error', () => {
    expect(isTooHardAbortError(new Error('some other failure'))).toBe(false)
    expect(isTooHardAbortError(new Error('blockers; aborting dispatch'))).toBe(false)
  })

  it('recognises the sentinel through a Mastra-wrapped cause chain', () => {
    const cause = new Error(TOO_HARD_ABORT_MESSAGE('mars-abc12345'))
    const wrapped = new Error('Step run-claude-code failed: something')
    Object.assign(wrapped, { cause })
    expect(isTooHardAbortError(wrapped)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Diagnose Chore spawn — prompt contract
//
// The read-span guard spawns a diagnose Chore carrying buildDiagnoseChorePrompt.
// These tests assert that the spawned prompt enforces the diagnose-only
// contract and that no legacy three-way wording ("note OR surgical change OR
// file an idea") remains. See PRD 06e677fb and acceptance criteria slice 2.
// ---------------------------------------------------------------------------

const SAMPLE_TRACE: readonly ReadSpanTrace[] = [
  { tool: 'Read', target: 'src/foo.ts' },
  { tool: 'Read', target: 'src/bar.ts' },
  { tool: 'Grep', target: 'fooImpl' },
  { tool: 'Read', target: 'src/baz.ts' },
  { tool: 'Glob', target: 'src/**/*.ts' },
]

describe('read-span trip — diagnose Chore prompt contract', () => {
  it('spawned prompt explicitly forbids attempting the parent task', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).toMatch(/MUST NOT/)
    expect(prompt).toMatch(/attempt the parent task/)
  })

  it('spawned prompt explicitly forbids making the fix', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).toMatch(/make the fix yourself/)
  })

  it('spawned prompt instructs verdict recording via mars diagnose set', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).toMatch(/mars diagnose set mars-parent01/)
    expect(prompt).toMatch(/"kind": "root-cause-found"/)
    expect(prompt).toMatch(/"kind": "inconclusive"/)
  })

  it('spawned prompt includes the parent task prompt verbatim', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).toContain('do the original work')
  })

  it('spawned prompt includes the read trail that preceded the abort', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).toContain('## Read trail before abort')
    expect(prompt).toContain('src/foo.ts')
    expect(prompt).toContain('Grep')
  })

  it('does NOT offer the legacy "produce a concise note" option', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).not.toMatch(/produce a concise note/i)
  })

  it('does NOT offer the legacy "small surgical change" option', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).not.toMatch(/small surgical change/i)
  })

  it('does NOT offer the legacy "mars proposal add" / "file a mars proposal" option', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).not.toMatch(/mars proposal add/i)
    expect(prompt).not.toMatch(/file a `mars proposal/i)
  })

  it('spawned child is exempt from the read-span guard (stated in the prompt)', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).toMatch(/exempt from the read-span guard/)
  })

  it('forbids spawning another diagnose Chore (terminality invariant)', () => {
    const prompt = buildDiagnoseChorePrompt('mars-parent01', 'do the original work', SAMPLE_TRACE)
    expect(prompt).toMatch(/spawn another diagnose Chore|any other follow-up task/)
  })
})
