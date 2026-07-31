import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  verifyChanges,
  loadVerifyScopes,
  selectVerifySteps,
  getChangedFiles,
  checkBranchHasDiff,
  TSC_DECOY_MARKER,
  type VerifyScope,
} from '../git/verify'
import {
  parseMainCommiterPayload,
  MAIN_COMMITER_RECIPE,
  serialiseMainCommiterPayload,
} from '../main-dirty'

const truthyCmd = { cmd: 'node', args: ['-e', 'process.exit(0)'] }
const falsyCmd = { cmd: 'node', args: ['-e', 'process.stderr.write("boom"); process.exit(1)'] }

describe('verifyChanges (data-driven)', () => {
  it('runs steps in declared order and stops on first required failure', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [
        { name: 'a', ...truthyCmd, required: true },
        { name: 'b', ...falsyCmd, required: true },
        { name: 'c', ...truthyCmd, required: true },
      ],
    })
    expect(r.passed).toBe(false)
    expect(r.steps.map((s) => s.name)).toEqual(['a', 'b'])
    expect(r.steps[0].passed).toBe(true)
    expect(r.steps[1].passed).toBe(false)
    expect(r.steps[1].output).toContain('boom')
  })

  it('continues past a non-required failure and reports passed=true if no required step failed', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [
        { name: 'a', ...truthyCmd, required: true },
        { name: 'optional-lint', ...falsyCmd, required: false },
        { name: 'b', ...truthyCmd, required: true },
      ],
    })
    expect(r.steps.map((s) => s.name)).toEqual(['a', 'optional-lint', 'b'])
    expect(r.steps[1].passed).toBe(false)
    expect(r.passed).toBe(true)
  })

  it('reports passed=false if a required step fails even with non-required ones passing', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [
        { name: 'opt', ...truthyCmd, required: false },
        { name: 'req', ...falsyCmd, required: true },
      ],
    })
    expect(r.passed).toBe(false)
  })
})

describe('checkBranchHasDiff (zero-ahead is benign)', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-verify-diff-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'README'), 'hello\n')
    execFileSync('git', ['add', 'README'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    // task/with-commit: branch ahead of main by one commit.
    execFileSync('git', ['checkout', '-q', '-b', 'task/with-commit', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'NEW'), 'new\n')
    execFileSync('git', ['add', 'NEW'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'add new'], { cwd: repo })
    // task/already-merged: simulate the post-merge ghost-no-diff case —
    // the branch had a commit, that commit fast-forwarded into main, then
    // main moved past it. The branch tip is now a strict ancestor of main.
    execFileSync('git', ['checkout', '-q', '-b', 'task/already-merged', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'SHIPPED'), 'shipped\n')
    execFileSync('git', ['add', 'SHIPPED'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'feat: shipped'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    execFileSync('git', ['merge', '-q', '--ff-only', 'task/already-merged'], { cwd: repo })
    writeFileSync(resolve(repo, 'AFTER'), 'after\n')
    execFileSync('git', ['add', 'AFTER'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'chore: after'], { cwd: repo })
    // task/empty: branch tip equals main; agent did nothing. Create this
    // last so it points at the final main tip, not at any earlier commit.
    execFileSync('git', ['checkout', '-q', '-b', 'task/empty', 'main'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('passes a legitimate no-op when the branch tip equals integration', async () => {
    // The branch never moved off the integration tip (the agent did nothing,
    // e.g. a main-committer finding the tree already clean). The integration
    // branch is clean and nothing is un-merged, so this must pass rather than
    // fail and strand any chain blocked on it (the 2026-05-29 incident).
    const step = await checkBranchHasDiff(repo, 'task/empty', 'main')
    expect(step.name).toBe('has-diff')
    expect(step.passed).toBe(true)
    expect(step.output).toContain('no un-integrated work')
  })

  it('returns passed=true when the branch has commits ahead', async () => {
    const step = await checkBranchHasDiff(repo, 'task/with-commit', 'main')
    expect(step.passed).toBe(true)
  })

  it('returns passed=true when the branch is a strict ancestor of integration (work already merged)', async () => {
    const step = await checkBranchHasDiff(repo, 'task/already-merged', 'main')
    expect(step.passed).toBe(true)
    expect(step.output).toContain('already merged')
  })

  it('verifyChanges proceeds to the configured steps for a no-op branch, and has-diff appears first', async () => {
    // A no-op branch (tip == integration) passes the has-diff gate, so the
    // configured steps still run. The passing has-diff gate is now included in
    // results so gate-outcomes correctly shows what ran.
    // Check out the task branch so assertWorktreeHygieneForVerify passes (it
    // validates that the expected branch is checked out at the cwd).
    execFileSync('git', ['checkout', '-q', 'task/empty'], { cwd: repo })
    let r: { passed: boolean; steps: { name: string; passed: boolean }[] }
    try {
      r = await verifyChanges({
        cwd: repo,
        branch: 'task/empty',
        integrationBranch: 'main',
        steps: [{ name: 'runs-after-gate', ...truthyCmd, required: true }],
      })
    } finally {
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    }
    expect(r.passed).toBe(true)
    expect(r.steps.map((s) => s.name)).toEqual(['has-diff', 'runs-after-gate'])
    expect(r.steps[0].name).toBe('has-diff')
    expect(r.steps[0].passed).toBe(true)
    expect(r.steps[1].passed).toBe(true)
  })

  it('verifyChanges still short-circuits when the has-diff gate cannot compute the range', async () => {
    // A genuine gate error (unknown integration ref) must still fail fast,
    // before any configured step runs — and must be reported as `has-diff`,
    // because the gate genuinely ran and genuinely could not compute a range.
    //
    // Check out the task branch first so the pre-verify hygiene probe passes.
    // Without this the probe fails on branch drift and short-circuits BEFORE
    // the has-diff gate, so the assertion below would be satisfied by a
    // hygiene failure wearing the has-diff label rather than by the gate
    // error this test is about. That mislabelling is exactly what the
    // `worktree-hygiene` step name was introduced to end.
    execFileSync('git', ['checkout', '-q', 'task/empty'], { cwd: repo })
    let r: { passed: boolean; steps: { name: string }[] }
    try {
      r = await verifyChanges({
        cwd: repo,
        branch: 'task/empty',
        integrationBranch: 'no-such-ref',
        steps: [{ name: 'should-not-run', ...truthyCmd, required: true }],
      })
    } finally {
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    }
    expect(r.passed).toBe(false)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].name).toBe('has-diff')
  })

  it('reports a hygiene failure under its own name, never as has-diff', async () => {
    // The repo is checked out on `main`, so the task branch is not present in
    // the working tree — a branch-drift hygiene failure. It must NOT masquerade
    // as a verdict about the branch's diff, which was never examined.
    const r = await verifyChanges({
      cwd: repo,
      branch: 'task/empty',
      integrationBranch: 'main',
      steps: [{ name: 'should-not-run', ...truthyCmd, required: true }],
    })
    expect(r.passed).toBe(false)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].name).toBe('worktree-hygiene')
    expect(r.steps[0].output).toContain('wrong branch')
  })

  // Regression guard for the systemic `verify:has-diff/no-commits-ahead`
  // failures: when the workflow's `resolveVerifyCwd` picks a `package.json`
  // subdirectory of the worktree (e.g. `<worktree>/orchestrator`), the
  // rev-list invocation must still resolve the shared `task/<id>` ref and
  // recognise that a commit exists. Operating from a sub-cwd was one of
  // the leading hypotheses for the false-positive failures.
  it('returns passed=true when run from a subdirectory of the worktree', async () => {
    const sub = resolve(repo, 'sub')
    if (!existsSync(sub)) mkdirSync(sub)
    const step = await checkBranchHasDiff(sub, 'task/with-commit', 'main')
    expect(step.passed).toBe(true)
    expect(step.output).toMatch(/commit\(s\) ahead/)
  })

  it('embeds diagnostic context in the accepted no-op output', async () => {
    const step = await checkBranchHasDiff(repo, 'task/empty', 'main')
    expect(step.passed).toBe(true)
    // SHA probes still ride along on the (now passing) no-op so a post-mortem
    // can cross-reference the ref state without re-shelling into the worktree.
    expect(step.output).toContain('HEAD:')
    expect(step.output).toContain('task/empty:')
    expect(step.output).toContain('main:')
    expect(step.output).toContain('status:')
    expect(step.output).toContain('recent log on task/empty:')
  })
})

describe('loadVerifyScopes', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(resolve(tmpdir(), 'mars-loadverify-'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('returns no scopes (no-op pass) when manifest is missing', async () => {
    const scopes = await loadVerifyScopes(resolve(workDir, 'nope.json'))
    expect(scopes).toEqual([])
  })

  it('returns no scopes (no-op pass) when manifest has no verify entries', async () => {
    const path = resolve(workDir, 'manifest-no-entries.json')
    writeFileSync(
      path,
      JSON.stringify({ supervisors: [{ name: 'baseline-supervisor' }] }),
    )
    const scopes = await loadVerifyScopes(path)
    expect(scopes).toEqual([])
  })

  it('missing manifest yields passed:true with zero steps end-to-end', async () => {
    const scopes = await loadVerifyScopes(resolve(workDir, 'absent.json'))
    const steps = selectVerifySteps(scopes, [])
    expect(steps).toEqual([])
    // verifyChanges with no steps passes immediately (no required failures)
    const result = await verifyChanges({ steps, cwd: workDir })
    expect(result.passed).toBe(true)
    expect(result.steps).toEqual([])
  })

  it('keeps a step name declared by two different scopes as two distinct, scope-tagged steps', async () => {
    const path = resolve(workDir, 'no-collapse.json')
    writeFileSync(
      path,
      JSON.stringify({
        supervisors: [
          {
            name: 'web-supervisor',
            scope: 'apps/web',
            verify: [{ name: 'test', cmd: 'web-test', args: [], required: true }],
          },
          {
            name: 'api-supervisor',
            scope: 'services/api',
            verify: [{ name: 'test', cmd: 'api-test', args: [], required: true }],
          },
        ],
      }),
    )
    const scopes = await loadVerifyScopes(path)
    expect(scopes.map((s) => s.scope)).toEqual(['apps/web', 'services/api'])
    const web = scopes.find((s) => s.scope === 'apps/web')
    const api = scopes.find((s) => s.scope === 'services/api')
    expect(web?.steps.map((s) => [s.name, s.cmd, s.dir])).toEqual([
      ['test', 'web-test', 'apps/web'],
    ])
    expect(api?.steps.map((s) => [s.name, s.cmd, s.dir])).toEqual([
      ['test', 'api-test', 'services/api'],
    ])
  })

  it('keeps non-JavaScript scope commands verbatim and injects no typecheck/test step', async () => {
    const path = resolve(workDir, 'non-js.json')
    writeFileSync(
      path,
      JSON.stringify({
        supervisors: [
          {
            name: 'go-supervisor',
            scope: '.',
            verify: [
              { name: 'go-vet', cmd: 'go', args: ['vet', './...'], required: true },
              { name: 'go-test', cmd: 'go', args: ['test', './...'], required: true },
            ],
          },
        ],
      }),
    )
    const scopes = await loadVerifyScopes(path)
    expect(scopes).toHaveLength(1)
    const steps = scopes[0].steps
    expect(steps.map((s) => [s.cmd, ...s.args])).toEqual([
      ['go', 'vet', './...'],
      ['go', 'test', './...'],
    ])
    expect(steps.some((s) => s.name === 'typecheck')).toBe(false)
    expect(steps.some((s) => s.cmd === 'npx' || s.cmd === 'npm')).toBe(false)
  })

  it('normalises root scope variants and dedupes a repeated step name within a scope', async () => {
    const path = resolve(workDir, 'root-norm.json')
    writeFileSync(
      path,
      JSON.stringify({
        supervisors: [
          {
            name: 'root-supervisor',
            scope: './',
            verify: [
              { name: 'test', cmd: 'first', args: [], required: true },
              { name: 'test', cmd: 'second', args: [], required: true },
            ],
          },
        ],
      }),
    )
    const scopes = await loadVerifyScopes(path)
    expect(scopes.map((s) => s.scope)).toEqual(['.'])
    expect(scopes[0].steps.map((s) => [s.name, s.cmd])).toEqual([
      ['test', 'first'],
    ])
  })
})

describe('selectVerifySteps (scope-aware selection from the real diff)', () => {
  const recipe: VerifyScope[] = [
    {
      scope: '.',
      steps: [{ name: 'root-lint', cmd: 'rootcmd', args: [], required: true, dir: '.' }],
    },
    {
      scope: 'apps/web',
      steps: [{ name: 'test', cmd: 'web-test', args: [], required: true, dir: 'apps/web' }],
    },
    {
      scope: 'services/api',
      steps: [{ name: 'test', cmd: 'api-test', args: [], required: true, dir: 'services/api' }],
    },
  ]

  it('runs the root scope plus both subtrees when changed files span two subtrees', () => {
    const steps = selectVerifySteps(recipe, [
      'apps/web/src/App.tsx',
      'services/api/handlers/users.go',
    ])
    expect(steps.map((s) => [s.name, s.cmd, s.dir])).toEqual([
      ['root-lint', 'rootcmd', '.'],
      ['test', 'web-test', 'apps/web'],
      ['test', 'api-test', 'services/api'],
    ])
  })

  it('runs the root scope plus only the touched subtree, not the other', () => {
    const steps = selectVerifySteps(recipe, ['apps/web/src/index.ts'])
    expect(steps.map((s) => [s.name, s.dir])).toEqual([
      ['root-lint', '.'],
      ['test', 'apps/web'],
    ])
    expect(steps.some((s) => s.cmd === 'api-test')).toBe(false)
  })

  it('runs only the root scope when nothing but docs / root config changed', () => {
    const steps = selectVerifySteps(recipe, ['README.md', 'package.json'])
    expect(steps.map((s) => [s.name, s.dir])).toEqual([['root-lint', '.']])
  })

  it('contributes no steps for a scope whose subtree contains no changed file', () => {
    const steps = selectVerifySteps(recipe, ['services/api/main.go'])
    expect(steps.some((s) => s.dir === 'apps/web')).toBe(false)
    expect(steps.map((s) => s.dir)).toEqual(['.', 'services/api'])
  })

  it('always runs the root floor even when the recipe declares it after narrower scopes', () => {
    const reordered: VerifyScope[] = [recipe[1], recipe[2], recipe[0]]
    const steps = selectVerifySteps(reordered, ['apps/web/x.ts'])
    expect(steps[0].dir).toBe('.')
    expect(steps.map((s) => s.dir)).toEqual(['.', 'apps/web'])
  })
})

describe('verifyChanges runs each step in its own scope directory', () => {
  let root: string

  beforeAll(() => {
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'mars-scopedir-')))
    mkdirSync(resolve(root, 'apps/web'), { recursive: true })
    mkdirSync(resolve(root, 'services/api'), { recursive: true })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('executes a step with a scope dir in that subdirectory, not the verify root', async () => {
    const pwdCmd = {
      cmd: 'node',
      args: ['-e', 'process.stdout.write(process.cwd())'],
    }
    const r = await verifyChanges({
      cwd: root,
      steps: [
        { name: 'root-step', ...pwdCmd, required: true, dir: '.' },
        { name: 'web-step', ...pwdCmd, required: true, dir: 'apps/web' },
        { name: 'api-step', ...pwdCmd, required: true, dir: 'services/api' },
      ],
    })
    expect(r.passed).toBe(true)
    const byName = new Map(r.steps.map((s) => [s.name, s.output]))
    expect(byName.get('root-step')).toBe(root)
    expect(byName.get('web-step')).toBe(resolve(root, 'apps/web'))
    expect(byName.get('api-step')).toBe(resolve(root, 'services/api'))
  })
})

describe('getChangedFiles', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-changed-files-'))
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    writeFileSync(resolve(repo, 'README.md'), 'hello\n')
    git('add', 'README.md')
    git('commit', '-q', '-m', 'init')
    git('checkout', '-q', '-b', 'task/multi', 'main')
    mkdirSync(resolve(repo, 'apps/web'), { recursive: true })
    mkdirSync(resolve(repo, 'services/api'), { recursive: true })
    writeFileSync(resolve(repo, 'apps/web/App.tsx'), 'x\n')
    writeFileSync(resolve(repo, 'services/api/main.go'), 'y\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'full-stack change')
    git('checkout', '-q', 'main')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the repo-relative paths a branch changed against integration', async () => {
    const files = await getChangedFiles(repo, 'main', 'task/multi')
    expect([...files].sort()).toEqual([
      'apps/web/App.tsx',
      'services/api/main.go',
    ])
  })

  it('returns an empty list rather than throwing when git fails', async () => {
    const files = await getChangedFiles(repo, 'main', 'no-such-branch')
    expect(files).toEqual([])
  })
})

// Regression: a task branch that is BEHIND the integration branch (the normal
// state — tasks code in parallel while `main` keeps advancing) must report
// only the files it changed itself. A two-dot `main..branch` diff compares the
// two tips and therefore also reports everything `main` changed after the
// fork, inflating the list and making selectVerifySteps pull in verify scopes
// the task never touched. Only three-dot (merge-base) semantics is correct.
describe('getChangedFiles on a branch behind the integration branch', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-changed-files-behind-'))
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repo })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'test')
    mkdirSync(resolve(repo, 'orchestrator'), { recursive: true })
    mkdirSync(resolve(repo, 'ui'), { recursive: true })
    writeFileSync(resolve(repo, 'README.md'), 'hello\n')
    writeFileSync(resolve(repo, 'ui/App.tsx'), 'base\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')

    // Fork the task branch here and give it one orchestrator-only commit.
    git('checkout', '-q', '-b', 'task/behind', 'main')
    writeFileSync(resolve(repo, 'orchestrator/task-change.ts'), 'task\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'task change (orchestrator only)')

    // Now advance `main` underneath it: main touches ui/ and adds files the
    // task branch has never seen. The task branch is 1 ahead, 2 behind.
    git('checkout', '-q', 'main')
    writeFileSync(resolve(repo, 'ui/App.tsx'), 'moved on\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'main advances ui/')
    writeFileSync(resolve(repo, 'ui/Extra.tsx'), 'new on main\n')
    writeFileSync(resolve(repo, 'services-note.md'), 'new on main\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'main adds more files')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it("reports only the branch's own changes, not the integration branch's", async () => {
    const files = await getChangedFiles(repo, 'main', 'task/behind')
    expect([...files].sort()).toEqual(['orchestrator/task-change.ts'])
  })

  it('does not select verify scopes the task never touched', async () => {
    const changed = await getChangedFiles(repo, 'main', 'task/behind')
    const mkStep = (name: string, dir: string) => ({
      name,
      cmd: name,
      args: [] as string[],
      required: true,
      dir,
    })
    const scopes: VerifyScope[] = [
      { scope: '.', steps: [mkStep('root-lint', '.')] },
      { scope: 'orchestrator', steps: [mkStep('orch-test', 'orchestrator')] },
      { scope: 'ui', steps: [mkStep('ui-test', 'ui')] },
    ]
    const selected = selectVerifySteps(scopes, changed).map((s) => s.name)
    expect(selected).toEqual(['root-lint', 'orch-test'])
    expect(selected).not.toContain('ui-test')
  })
})

// ---------------------------------------------------------------------------
// Tier-gate model (ADR: gate stack with per-gate tiers)
// ---------------------------------------------------------------------------
// The verify recipe step gains a `tier` field: 'task' (cheap; runs during the
// per-task verify phase) or 'integration' (expensive; deferred to the
// integration boundary). Default when absent: 'task'.
//
// The verify phase runs ONLY tier:'task' gates. Integration-tier gates are
// parsed and recorded but NOT executed; they appear in the step results with
// passed:true and output "deferred to integration".
//
// Per-gate outcomes (name, tier, passed, duration) are attached to each
// VerifyStep so the run-timeline view can surface them.
// ---------------------------------------------------------------------------
describe('tier-gate model', () => {
  it('defers integration-tier steps without running them', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [
        { name: 'typecheck', ...truthyCmd, required: true },
        {
          name: 'full-suite',
          cmd: 'node',
          args: ['-e', 'process.stderr.write("SHOULD NOT RUN"); process.exit(1)'],
          required: true,
          tier: 'integration' as const,
        },
      ],
    })
    expect(r.passed).toBe(true)
    expect(r.steps).toHaveLength(2)
    const deferred = r.steps.find((s) => s.name === 'full-suite')
    expect(deferred?.tier).toBe('integration')
    expect(deferred?.passed).toBe(true)
    expect(deferred?.output).toContain('deferred to integration')
    // The integration step must not have actually run (output must not contain SHOULD NOT RUN)
    expect(deferred?.output).not.toContain('SHOULD NOT RUN')
  })

  it('runs task-tier steps and records tier:task and a duration', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [{ name: 'typecheck', ...truthyCmd, required: true }],
    })
    expect(r.passed).toBe(true)
    expect(r.steps).toHaveLength(1)
    const step = r.steps[0]
    expect(step.tier).toBe('task')
    expect(typeof step.duration).toBe('number')
    expect(step.duration).toBeGreaterThanOrEqual(0)
  })

  it('steps without an explicit tier default to tier:task', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [{ name: 'lint', ...truthyCmd, required: false }],
    })
    expect(r.steps[0].tier).toBe('task')
  })

  it('a required task-tier failure stops subsequent required task steps; integration steps are still deferred', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [
        { name: 'typecheck', ...falsyCmd, required: true },
        {
          name: 'full-suite',
          cmd: 'node',
          args: ['-e', 'process.exit(0)'],
          required: true,
          tier: 'integration' as const,
        },
        { name: 'second-task', ...truthyCmd, required: true },
      ],
    })
    // Overall: failed because typecheck (required) failed
    expect(r.passed).toBe(false)
    // typecheck ran and failed
    expect(r.steps[0].name).toBe('typecheck')
    expect(r.steps[0].passed).toBe(false)
    expect(r.steps[0].tier).toBe('task')
    // full-suite is deferred (integration tier) — not blocked by typecheck failure
    expect(r.steps[1].name).toBe('full-suite')
    expect(r.steps[1].tier).toBe('integration')
    expect(r.steps[1].passed).toBe(true)
    // second-task is a required task step AFTER a required failure — skipped
    expect(r.steps).toHaveLength(2)
  })

  it('integration-tier steps do not affect the required-failure outcome', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [
        {
          name: 'full-suite',
          cmd: 'node',
          args: ['-e', 'process.exit(0)'],
          required: true,
          tier: 'integration' as const,
        },
      ],
    })
    // A single integration-tier step produces passed:true (deferred, not a failure)
    expect(r.passed).toBe(true)
  })

  it('loadVerifyScopes propagates tier from the manifest', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-tier-load-'))
    try {
      const manifestPath = resolve(dir, 'supervisors.json')
      writeFileSync(
        manifestPath,
        JSON.stringify({
          supervisors: [
            {
              name: 'node-backend-supervisor',
              scope: '.',
              verify: [
                { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
                { name: 'test', cmd: 'npm', args: ['test'], required: true, tier: 'integration' },
                { name: 'lint', cmd: 'npx', args: ['eslint', '.'], required: false },
              ],
            },
          ],
        }),
      )
      const scopes = await loadVerifyScopes(manifestPath)
      expect(scopes).toHaveLength(1)
      const steps = scopes[0].steps
      const typecheck = steps.find((s) => s.name === 'typecheck')
      const test = steps.find((s) => s.name === 'test')
      const lint = steps.find((s) => s.name === 'lint')
      // tier explicitly set to 'integration' is propagated
      expect(test?.tier).toBe('integration')
      // tier not set → absent (defaults to 'task' at runtime)
      expect(typecheck?.tier).toBeUndefined()
      expect(lint?.tier).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// main-commiter verify exemption (regression for task d0f9b1d4)
// ---------------------------------------------------------------------------
// A main-commiter recovery task's sole success criterion is a clean working
// tree — it must never run test/typecheck/lint. The workflow detects this by
// parsing recovery_payload.recipe and short-circuiting selectVerifySteps to
// an empty array. These tests pin that decision.
// ---------------------------------------------------------------------------

describe('main-commiter recovery — verify step exemption', () => {
  const scopeWithSteps: VerifyScope[] = [
    {
      scope: '.',
      steps: [
        { name: 'test', cmd: 'npx', args: ['vitest', 'run'], required: true, dir: '.' },
        { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true, dir: '.' },
        { name: 'lint', cmd: 'npx', args: ['eslint', '.'], required: false, dir: '.' },
      ],
    },
  ]
  const changedFiles = ['src/foo.ts']

  it('selects zero verify steps when recovery_payload.recipe is main-commiter', () => {
    const payload = serialiseMainCommiterPayload({
      recipe: MAIN_COMMITER_RECIPE,
      integrationBranch: 'main',
    })
    const commiterPayload = parseMainCommiterPayload(payload)
    const steps =
      commiterPayload?.recipe === MAIN_COMMITER_RECIPE
        ? []
        : selectVerifySteps(scopeWithSteps, changedFiles)
    expect(steps).toEqual([])
  })

  it('selects full verify steps when recovery_payload is null (non-fix task)', () => {
    const commiterPayload = parseMainCommiterPayload(null)
    const steps =
      commiterPayload?.recipe === MAIN_COMMITER_RECIPE
        ? []
        : selectVerifySteps(scopeWithSteps, changedFiles)
    expect(steps.map((s) => s.name)).toEqual(['test', 'typecheck', 'lint'])
  })

  it('selects full verify steps when recovery_payload has a different recipe', () => {
    const rawPayload = JSON.stringify({
      recipe: 'some-other-recovery-recipe',
      integrationBranch: 'main',
    })
    const commiterPayload = parseMainCommiterPayload(rawPayload)
    // parseMainCommiterPayload returns null for unknown recipes
    const steps =
      commiterPayload?.recipe === MAIN_COMMITER_RECIPE
        ? []
        : selectVerifySteps(scopeWithSteps, changedFiles)
    expect(steps.map((s) => s.name)).toEqual(['test', 'typecheck', 'lint'])
  })

  it('verifyChanges with zero steps and no changedFiles (main-committer recipe) passes', async () => {
    // Zero configured steps pass — verify gates are optional. This regression
    // pin ensures the main-committer recipe (which selects no steps) verifies
    // cleanly.
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [],
      // changedFiles intentionally absent — mirrors the primitive's call for
      // the main-committer recipe (isMainCommitter ? undefined : changedFiles)
    })
    expect(r.passed).toBe(true)
    expect(r.steps).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Typecheck step — tsc-presence guard (regression for spurious
// verify:typecheck failures in non-TypeScript repos such as gustave).
//
// When a supervisors manifest includes an `npx tsc --noEmit` step but the
// verify target has no real TypeScript toolchain installed (Kotlin/Gradle
// repos, cross-repo tasks, repos where node_modules was never installed),
// the step must be SKIPPED rather than run. Running it would invoke the npm
// decoy package and produce "This is not the tsc command you are looking
// for" — a misconfiguration signal, not a code-level typecheck failure.
// ---------------------------------------------------------------------------
describe('typecheck step — no-tsc-toolchain skip guard', () => {
  const typecheckStep = {
    name: 'typecheck',
    cmd: 'npx',
    args: ['tsc', '--noEmit'],
    required: true,
  }

  it('skips and passes (no failure) when the step dir has no tsconfig.json', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-tsc-skip-no-tsconfig-'))
    try {
      // Neither tsconfig.json nor node_modules/.bin/tsc — a pure Kotlin repo.
      const r = await verifyChanges({ cwd: dir, steps: [typecheckStep] })
      expect(r.passed).toBe(true)
      expect(r.steps).toHaveLength(1)
      expect(r.steps[0].passed).toBe(true)
      expect(r.steps[0].output).toMatch(/skipped/i)
      // The guard must NOT report a verify:typecheck/unclassified style failure.
      expect(r.steps[0].output).not.toContain(TSC_DECOY_MARKER)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips and passes when tsconfig.json is present but node_modules/.bin/tsc is absent', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-tsc-skip-no-bin-'))
    try {
      writeFileSync(resolve(dir, 'tsconfig.json'), '{}')
      // tsconfig exists but TypeScript is not npm-installed — decoy risk.
      const r = await verifyChanges({ cwd: dir, steps: [typecheckStep] })
      expect(r.passed).toBe(true)
      expect(r.steps[0].passed).toBe(true)
      expect(r.steps[0].output).toMatch(/skipped/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT skip when both tsconfig.json and node_modules/.bin/tsc are present', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-tsc-runs-'))
    try {
      writeFileSync(resolve(dir, 'tsconfig.json'), '{}')
      const binDir = resolve(dir, 'node_modules', '.bin')
      mkdirSync(binDir, { recursive: true })
      // Fake tsc that exits 0 — the presence guard should not fire.
      const fakeTsc = resolve(binDir, 'tsc')
      writeFileSync(fakeTsc, '#!/bin/sh\nexit 0\n')
      chmodSync(fakeTsc, 0o755)
      const r = await verifyChanges({ cwd: dir, steps: [typecheckStep] })
      expect(r.passed).toBe(true)
      // The step should have ACTUALLY run (not been silently skipped by the
      // pre-flight guard), so the output must not contain "skipped".
      expect(r.steps[0].output).not.toMatch(/skipped/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats decoy-tsc output as a skip signal rather than a typecheck failure', async () => {
    // Represents the scenario where the pre-flight guard passes (tsconfig.json
    // + local tsc binary both present) but the binary itself is the npm decoy
    // — it outputs the well-known marker and exits non-zero.
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-tsc-decoy-'))
    try {
      writeFileSync(resolve(dir, 'tsconfig.json'), '{}')
      const binDir = resolve(dir, 'node_modules', '.bin')
      mkdirSync(binDir, { recursive: true })
      // Decoy: outputs the marker and exits 1 — mirrors the real npm placeholder.
      const decoyTsc = resolve(binDir, 'tsc')
      writeFileSync(
        decoyTsc,
        `#!/bin/sh\necho "${TSC_DECOY_MARKER}"\nexit 1\n`,
      )
      chmodSync(decoyTsc, 0o755)
      const r = await verifyChanges({ cwd: dir, steps: [typecheckStep] })
      // Must not produce a verify:typecheck failure — the step passes as a skip.
      expect(r.passed).toBe(true)
      expect(r.steps[0].passed).toBe(true)
      expect(r.steps[0].output).toMatch(/decoy|skipped/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// No zero-gate guard — verify gates are optional
// ---------------------------------------------------------------------------
// Verify gates are opt-in. A task with zero configured task-tier steps passes
// the verify phase (running only the built-in gates), whether or not it changed
// files. There is intentionally no "you must configure gates" guard.
// ---------------------------------------------------------------------------
describe('no zero-gate guard — gates are optional', () => {
  it('passes with zero steps even when changedFiles is non-empty', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [],
      changedFiles: ['src/foo.ts', 'src/bar.ts'],
    })
    expect(r.passed).toBe(true)
    expect(r.steps).toEqual([])
  })

  it('passes when changedFiles is empty and no task-tier steps (genuine no-op)', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [],
      changedFiles: [],
    })
    expect(r.passed).toBe(true)
    expect(r.steps).toEqual([])
  })

  it('passes when changedFiles is not provided and no task-tier steps (main-committer path)', async () => {
    const r = await verifyChanges({
      cwd: process.cwd(),
      steps: [],
      // changedFiles intentionally omitted
    })
    expect(r.passed).toBe(true)
    expect(r.steps).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// has-diff gate appears in gate outcomes when it passes
// ---------------------------------------------------------------------------
// Previously, a passing has-diff gate was silently discarded from results;
// only a failing gate was returned. Now the passing gate is included so
// gate-outcomes correctly shows what ran. (A failing gate is still returned
// alone via early-return — that path is unchanged.)
// ---------------------------------------------------------------------------
describe('has-diff appears in gate outcomes when it passes', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-has-diff-outcomes-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'README'), 'hello\n')
    execFileSync('git', ['add', 'README'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    // task/with-step: one commit ahead of main
    execFileSync('git', ['checkout', '-q', '-b', 'task/with-step', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'CHANGE'), 'change\n')
    execFileSync('git', ['add', 'CHANGE'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'add change'], { cwd: repo })
    // task/noop: branch tip equals main
    execFileSync('git', ['checkout', '-q', '-b', 'task/noop', 'main'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('has-diff appears as the first step in results when it passes with configured task steps', async () => {
    // Check out the task branch so assertWorktreeHygieneForVerify passes.
    execFileSync('git', ['checkout', '-q', 'task/with-step'], { cwd: repo })
    let r: { passed: boolean; steps: { name: string; passed: boolean }[] }
    try {
      r = await verifyChanges({
        cwd: repo,
        branch: 'task/with-step',
        integrationBranch: 'main',
        steps: [{ name: 'lint', ...truthyCmd, required: true }],
      })
    } finally {
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    }
    expect(r.passed).toBe(true)
    expect(r.steps[0].name).toBe('has-diff')
    expect(r.steps[0].passed).toBe(true)
    expect(r.steps.map((s) => s.name)).toEqual(['has-diff', 'lint'])
  })

  it('has-diff is the sole step in results for a no-op branch with no task steps', async () => {
    // A no-op task with an empty step list still shows has-diff in gate outcomes.
    // Check out the task branch so assertWorktreeHygieneForVerify passes.
    execFileSync('git', ['checkout', '-q', 'task/noop'], { cwd: repo })
    let r: { passed: boolean; steps: { name: string; passed: boolean }[] }
    try {
      r = await verifyChanges({
        cwd: repo,
        branch: 'task/noop',
        integrationBranch: 'main',
        steps: [],
      })
    } finally {
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    }
    expect(r.passed).toBe(true)
    expect(r.steps.map((s) => s.name)).toEqual(['has-diff'])
    expect(r.steps[0].passed).toBe(true)
  })
})

