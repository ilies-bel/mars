import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  COMMIT_FOOTER,
  COMMIT_EXIT_CONDITION,
  CODING_DISCIPLINE,
  BLOCKERS_ABORT_MESSAGE,
  DEVIATION_RULES,
  CONTEXT_EXHAUSTED_ABORT_MESSAGE,
  CODER_EXIT_NONZERO_ABORT_MESSAGE,
  CODER_UNCOMMITTED_ABORT_MESSAGE,
  composePrompt,
  detectPostCoderState,
  failureExcerpt,
  ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE,
  recoveryAttachesToOrigin,
  resolveWorkerSystemPrompt,
  measureWorkerDispatchPrompt,
} from '../primitives/shared'
import { implementInputSchema } from '../implement-workflow'
import { WorkflowTerminalError } from '../../core/lib/workflow-terminal-error'
import { CONTEXT_GATHERING_BRIEF } from '../context-gathering-brief'

describe('workflow verify cwd', () => {
  it('anchors repo-relative supervisor scopes at the worktree root', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../primitives/index.ts'), 'utf8')
    expect(source).toContain('const verifyCwd = worktreePath')
    expect(source).not.toContain('const verifyCwd = resolveVerifyCwd(worktreePath)')
  })
})

describe('composePrompt — coder default', () => {
  it('reports the late Save your work section from the production Coder composition', () => {
    const report = measureWorkerDispatchPrompt('Coder', 'Commit the change.')
    const save = report.sections.find((section) => section.name === '## Save your work')

    expect(save?.depthPercent).toBeGreaterThan(80)
  })

  it('front-loads the commit exit condition before a bare prompt', () => {
    const out = composePrompt('do the thing', null)
    expect(out.startsWith(COMMIT_EXIT_CONDITION)).toBe(true)
    expect(out.indexOf('do the thing')).toBeGreaterThan(COMMIT_EXIT_CONDITION.length)
    // COMMIT_FOOTER is always present.
    const commitIdx = out.indexOf(COMMIT_FOOTER)
    expect(commitIdx).toBeGreaterThan(-1)
  })

  it('has one authoritative commit verification command', () => {
    expect(composePrompt('do the thing', null).match(/git rev-list --count/g)).toHaveLength(1)
  })

  it('does not repeat the commit instruction in the system deviation rules', () => {
    expect(DEVIATION_RULES).not.toMatch(/commit whatever in-scope work/i)
  })

  it('appends the commit footer after the plan sections', () => {
    const out = composePrompt('do the thing', {
      functional: 'F',
      technical: 'T',
    })
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

  it('warns against piping test commands through tail/head/grep (exit-code masking)', () => {
    // A pipeline like `npx vitest run 2>&1 | tail -25` exits with tail's status
    // (always 0), so a red suite reads as green. The footer must name this trap.
    expect(COMMIT_FOOTER).toContain('tail')
    expect(COMMIT_FOOTER).toContain('head')
    expect(COMMIT_FOOTER).toContain('grep')
    expect(COMMIT_FOOTER).toMatch(/exit code|exit status|exit propagat/i)
  })

  it('provides safe alternatives to exit-code-masking pipelines', () => {
    // The footer must offer at least one concrete alternative (direct run, temp
    // file capture, or set -o pipefail) so the agent has actionable guidance.
    expect(COMMIT_FOOTER).toMatch(/set -o pipefail|temp file|directly/i)
  })

  it('forbids asserting tests pass from a pipeline exit code ending in tail/head/grep', () => {
    expect(COMMIT_FOOTER).toMatch(/never assert|Never assert/i)
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
  it('always contains COMMIT_FOOTER in composed prompt', () => {
    // The writer-footer escape hatch is removed; every task gets the commit
    // footer so the diff gate fires uniformly on every dispatched run.
    for (const out of [
      composePrompt('do the thing', null),
      composePrompt('do the thing', null, 'coder'),
    ]) {
      const commitIdx = out.indexOf(COMMIT_FOOTER)
      expect(commitIdx).toBeGreaterThan(-1)
    }
  })

  it('always includes CODING_DISCIPLINE regardless of input', () => {
    // Before ADR 0019, writer tasks skipped CODING_DISCIPLINE. Now every task
    // includes it — there is no special-case branch.
    expect(composePrompt('do the thing', null)).toContain('## Coding discipline')
    expect(composePrompt('do the thing', null, 'coder')).toContain('## Coding discipline')
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
      { files: ['src/foo.ts'], verifyCmd: null, doneCriteria: [], mergeMode: 'auto' },
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
        verifyCmd: 'npx vitest run',        doneCriteria: ['it works'],
        mergeMode: 'auto',
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
        mergeMode: 'auto',
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

describe('WorkflowTerminalError — discriminant dispatch', () => {
  it('blockers-abort: carries the correct kind and message', () => {
    const err = new WorkflowTerminalError('blockers-abort', BLOCKERS_ABORT_MESSAGE('mars-abc'))
    expect(err).toBeInstanceOf(WorkflowTerminalError)
    expect(err.kind).toBe('blockers-abort')
    expect(err.message).toContain('mars-abc')
  })

  it('is not instanceof WorkflowTerminalError for a plain Error', () => {
    expect(new Error('verify command exited 1')).not.toBeInstanceOf(WorkflowTerminalError)
  })

  it('null and undefined are not instanceof WorkflowTerminalError', () => {
    // TypeScript does not allow null/undefined on the left of instanceof at the
    // type level; cast to unknown first to test the runtime behaviour.
    expect((null as unknown) instanceof WorkflowTerminalError).toBe(false)
    expect((undefined as unknown) instanceof WorkflowTerminalError).toBe(false)
  })

  it('quota-rejected: stores resetsAt in meta', () => {
    const err = new WorkflowTerminalError('quota-rejected', 'quota hit', { resetsAt: 1234567 })
    expect(err.kind).toBe('quota-rejected')
    expect(err.meta.resetsAt).toBe(1234567)
  })

  it('await-human: stores stepName in meta', () => {
    const err = new WorkflowTerminalError('await-human', 'parked', { stepName: 'review' })
    expect(err.kind).toBe('await-human')
    expect(err.meta.stepName).toBe('review')
  })

  it('all ten kinds are accepted by the WorkflowTerminalError constructor', () => {
    const kinds = [
      'blockers-abort',
      'context-exhausted',
      'origin-worktree-missing',
      'coder-exit-nonzero',
      'coder-uncommitted',
      'quota-rejected',
      'main-dirty-verify',
      'main-dirty-merge',
      'preview-gate',
      'await-human',
    ] as const
    for (const kind of kinds) {
      const err = new WorkflowTerminalError(kind, 'test')
      expect(err.kind).toBe(kind)
      expect(err).toBeInstanceOf(WorkflowTerminalError)
      expect(err).toBeInstanceOf(Error)
    }
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
      'Re-reading a file the sub-agent already summarised counts as analysis paralysis.',
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
      'Re-reading a file the sub-agent already summarised counts as analysis paralysis.',
    )
  })

  // The Writer system prompt test was removed by ADR 0019 (Writer Worker no longer exists).
})

describe('buildCoderSystemPrompt — context-gathering discipline brief', () => {
  it('coder standing instructions contain the context-gathering discipline brief', () => {
    const instructions = resolveWorkerSystemPrompt('coder')!
    expect(instructions).toContain(CONTEXT_GATHERING_BRIEF)
  })

  it('brief appears before the deviation rules section', () => {
    const instructions = resolveWorkerSystemPrompt('coder')!
    const briefIdx = instructions.indexOf(CONTEXT_GATHERING_BRIEF)
    const deviationRulesIdx = instructions.indexOf(DEVIATION_RULES)

    expect(briefIdx).toBeGreaterThan(-1)
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
        verifyCmd: 'npx tsc --noEmit',        doneCriteria: ['types pass'],
        mergeMode: 'auto',
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
        mergeMode: 'auto',
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
        verifyCmd: 'npx tsc --noEmit',        doneCriteria: [],
        mergeMode: 'auto',
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
        verifyCmd: 'npx tsc --noEmit',        doneCriteria: ['types pass'],
        mergeMode: 'auto',
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
        mergeMode: 'auto',
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
        mergeMode: 'auto',
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

// ---------------------------------------------------------------------------
// WorkflowTerminalError kind-specific tests
// (Sentinel detection tests: each kind maps to the correct throw-site message)
// ---------------------------------------------------------------------------

describe('WorkflowTerminalError — throw-site message embedding', () => {
  it('context-exhausted carries the taskId in its message', () => {
    const err = new WorkflowTerminalError('context-exhausted', CONTEXT_EXHAUSTED_ABORT_MESSAGE('mars-abc12345'))
    expect(err.kind).toBe('context-exhausted')
    expect(err.message).toContain('mars-abc12345')
    expect(err.message).toContain('context-budget ceiling')
  })

  it('coder-exit-nonzero carries the taskId and exit code in its message', () => {
    const err = new WorkflowTerminalError('coder-exit-nonzero', CODER_EXIT_NONZERO_ABORT_MESSAGE('mars-9afa7df6', 1))
    expect(err.kind).toBe('coder-exit-nonzero')
    expect(err.message).toContain('mars-9afa7df6')

    const err137 = new WorkflowTerminalError('coder-exit-nonzero', CODER_EXIT_NONZERO_ABORT_MESSAGE('mars-abc12345', 137))
    expect(err137.kind).toBe('coder-exit-nonzero')
    expect(err137.message).toContain('137')
  })

  it('coder-uncommitted is distinct from coder-exit-nonzero', () => {
    const uncommitted = new WorkflowTerminalError('coder-uncommitted', CODER_UNCOMMITTED_ABORT_MESSAGE('mars-c6cab686'))
    const exitNonzero = new WorkflowTerminalError('coder-exit-nonzero', CODER_EXIT_NONZERO_ABORT_MESSAGE('mars-c6cab686', 1))
    expect(uncommitted.kind).not.toBe(exitNonzero.kind)
    expect(uncommitted.kind).toBe('coder-uncommitted')
  })

  it('origin-worktree-missing carries the taskId in its message', () => {
    const err = new WorkflowTerminalError('origin-worktree-missing', ORIGIN_WORKTREE_MISSING_ABORT_MESSAGE('fix-abc12345'))
    expect(err.kind).toBe('origin-worktree-missing')
    expect(err.message).toContain('fix-abc12345')
  })
})

describe('recoveryAttachesToOrigin — origin-attach decision', () => {
  it('an ordinary kind=fix recovery attaches to its origin worktree', () => {
    expect(recoveryAttachesToOrigin('fix', false)).toBe(true)
  })

  it('a main-commiter kind=fix recovery does NOT attach (needs its own worktree)', () => {
    expect(recoveryAttachesToOrigin('fix', true)).toBe(false)
  })

  it('ordinary tasks and diagnose chores never attach (they create their own)', () => {
    expect(recoveryAttachesToOrigin('task', false)).toBe(false)
    expect(recoveryAttachesToOrigin('diagnose', false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// implementInputSchema — qa field threaded into workflow input
// ---------------------------------------------------------------------------

describe('implementInputSchema — qa field', () => {
  // Minimal required fields for a valid parse. All other fields have defaults.
  const base = {
    taskId: 'mars-test-1234',
    prompt: 'do the thing',
    integrationBranch: 'main',
    worktreePath: '/tmp/wt',
    repoRoot: '/tmp/repo',
    originSessionId: null,
  }

  it('defaults qa to "auto" when omitted', () => {
    const result = implementInputSchema.parse(base)
    expect(result.qa).toBe('auto')
  })

  it('accepts qa:"auto" explicitly', () => {
    const result = implementInputSchema.parse({ ...base, qa: 'auto' })
    expect(result.qa).toBe('auto')
  })

  it('accepts qa:"manual" explicitly', () => {
    const result = implementInputSchema.parse({ ...base, qa: 'manual' })
    expect(result.qa).toBe('manual')
  })

  it('rejects invalid qa values', () => {
    expect(() => implementInputSchema.parse({ ...base, qa: 'bad' })).toThrow()
    expect(() => implementInputSchema.parse({ ...base, qa: '' })).toThrow()
    expect(() => implementInputSchema.parse({ ...base, qa: 'Auto' })).toThrow()
  })

  it('qa is wired to reviewType in the review step (source inspection)', () => {
    // Guard: the implement-workflow must read ctx.input.qa and pass it as reviewType.
    // This source-level assertion prevents accidental disconnection.
    const source = readFileSync(
      resolve(import.meta.dirname, '../implement-workflow.ts'),
      'utf8',
    )
    expect(source).toContain('ctx.input.qa')
    expect(source).toContain('reviewType: qa')
  })
})
