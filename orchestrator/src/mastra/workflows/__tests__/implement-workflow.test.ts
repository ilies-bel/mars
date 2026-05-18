import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  COMMIT_FOOTER,
  WRITER_FOOTER,
  WRITER_SYSTEM_PROMPT,
  BLOCKERS_ABORT_MESSAGE,
  DIRTY_MAIN_ABORT_MESSAGE,
  DEVIATION_RULES,
  composePrompt,
  detectPostCoderState,
  failureExcerpt,
  isBlockersAbortError,
  isDirtyMainAbortError,
  resolveWorkerSystemPrompt,
  shouldWireReadSpanWatcher,
} from '../implement-workflow'

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

describe('composePrompt — writer routing', () => {
  it('appends the writer footer (not the coder commit footer) when tag is "writer"', () => {
    const out = composePrompt('add glossary terms', null, 'writer')
    expect(out.endsWith(WRITER_FOOTER)).toBe(true)
    expect(out).not.toContain(COMMIT_FOOTER)
  })

  it('writer footer names the canonical structured-write verbs', () => {
    expect(WRITER_FOOTER).toContain('mars glossary set')
    expect(WRITER_FOOTER).toContain('mars glossary remove')
    expect(WRITER_FOOTER).toContain('mars adr add')
  })

  it('writer footer makes clear the agent does not commit from the worktree', () => {
    expect(WRITER_FOOTER).toMatch(/daemon owns the commit|do not run `git/i)
  })

  it('writer system prompt disables Edit/Write/NotebookEdit explicitly', () => {
    expect(WRITER_SYSTEM_PROMPT).toContain('Edit, Write, and NotebookEdit are disabled')
  })

  it('writer system prompt names every supported verb so the agent has a closed list', () => {
    expect(WRITER_SYSTEM_PROMPT).toContain('mars glossary set')
    expect(WRITER_SYSTEM_PROMPT).toContain('mars glossary remove')
    expect(WRITER_SYSTEM_PROMPT).toContain('mars adr add')
  })

  it('writer task prompt does NOT contain deviation-rules text', () => {
    const out = composePrompt('add glossary terms', null, 'writer')
    expect(out).not.toContain('## Deviation rules')
  })
})

describe('shouldWireReadSpanWatcher — read-span guard exemption', () => {
  it("wires the watcher for an ordinary coder task (tag='coder', kind='task')", () => {
    expect(shouldWireReadSpanWatcher('coder', 'task')).toBe(true)
  })

  it("wires the watcher for a recovery fix-task (tag='coder', kind='fix')", () => {
    expect(shouldWireReadSpanWatcher('coder', 'fix')).toBe(true)
  })

  it("does NOT wire the watcher for a diagnose Chore (tag='coder', kind='diagnose')", () => {
    // PRD 06e677fb: heavy reading is the diagnose Chore's actual job;
    // its only backstop is the existing time/turn cap.
    expect(shouldWireReadSpanWatcher('coder', 'diagnose')).toBe(false)
  })

  it("does NOT wire the watcher for a writer task (tag='writer')", () => {
    expect(shouldWireReadSpanWatcher('writer', 'task')).toBe(false)
    expect(shouldWireReadSpanWatcher('writer', 'diagnose')).toBe(false)
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
    expect(out).not.toContain(WRITER_FOOTER)
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

describe('resolveWorkerSystemPrompt — deviation rules in coder standing instructions', () => {
  it('coder standing instructions contain the full deviation-rules text', () => {
    const prompt = resolveWorkerSystemPrompt('coder')
    expect(prompt).toContain('## Deviation rules')
    expect(prompt).toContain('do NOT quit silently')
  })

  it('writer standing instructions are byte-identical to WRITER_SYSTEM_PROMPT', () => {
    expect(resolveWorkerSystemPrompt('writer')).toBe(WRITER_SYSTEM_PROMPT)
  })

  it('DEVIATION_RULES is not injected as a standalone section — it is embedded in CODER_SYSTEM_PROMPT', () => {
    const coderPrompt = resolveWorkerSystemPrompt('coder')
    expect(coderPrompt).toContain(DEVIATION_RULES)
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

describe('isDirtyMainAbortError', () => {
  it('matches the bare dirty-main abort sentinel', () => {
    expect(
      isDirtyMainAbortError(new Error(DIRTY_MAIN_ABORT_MESSAGE('mars-abc'))),
    ).toBe(true)
  })

  it('does not false-positive on unrelated errors', () => {
    expect(isDirtyMainAbortError(new Error('tsc failed: TS2304'))).toBe(false)
    expect(isDirtyMainAbortError(new Error('verify command exited 1'))).toBe(false)
    expect(isDirtyMainAbortError(null)).toBe(false)
    expect(isDirtyMainAbortError(undefined)).toBe(false)
  })

  it('matches when Mastra wraps the sentinel on the cause chain', () => {
    const wrapped = new Error('Step setup-worktree failed', {
      cause: new Error(DIRTY_MAIN_ABORT_MESSAGE('mars-xyz')),
    })
    expect(isDirtyMainAbortError(wrapped)).toBe(true)
  })

  it('does not match the blockers sentinel', () => {
    expect(isDirtyMainAbortError(new Error(BLOCKERS_ABORT_MESSAGE('mars-abc')))).toBe(false)
  })

  it('DIRTY_MAIN_ABORT_MESSAGE contains the task id', () => {
    const msg = DIRTY_MAIN_ABORT_MESSAGE('mars-test-123')
    expect(msg).toContain('mars-test-123')
  })
})
