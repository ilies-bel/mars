import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
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
  type VerifyScope,
} from '../git/verify'

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

  it('verifyChanges proceeds to the configured steps for a no-op branch', async () => {
    // A no-op branch (tip == integration) passes the gate, so the configured
    // steps still run — the gate no longer short-circuits a clean no-op. (A
    // passing gate is not appended to steps; only a failing gate is returned.)
    const r = await verifyChanges({
      cwd: repo,
      branch: 'task/empty',
      integrationBranch: 'main',
      steps: [{ name: 'runs-after-gate', ...truthyCmd, required: true }],
    })
    expect(r.passed).toBe(true)
    expect(r.steps.map((s) => s.name)).toEqual(['runs-after-gate'])
    expect(r.steps[0].passed).toBe(true)
  })

  it('verifyChanges still short-circuits when the has-diff gate cannot compute the range', async () => {
    // A genuine gate error (unknown integration ref) must still fail fast,
    // before any configured step runs.
    const r = await verifyChanges({
      cwd: repo,
      branch: 'task/empty',
      integrationBranch: 'no-such-ref',
      steps: [{ name: 'should-not-run', ...truthyCmd, required: true }],
    })
    expect(r.passed).toBe(false)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].name).toBe('has-diff')
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

  it('returns a single root scope with default steps when manifest is missing', async () => {
    const scopes = await loadVerifyScopes(resolve(workDir, 'nope.json'))
    expect(scopes.map((s) => s.scope)).toEqual(['.'])
    expect(scopes[0].steps.map((s) => s.name)).toEqual([
      'typecheck',
      'test',
      'lint',
    ])
  })

  it('returns a single root scope with default steps when manifest has no verify entries', async () => {
    const path = resolve(workDir, 'manifest-no-entries.json')
    writeFileSync(
      path,
      JSON.stringify({ supervisors: [{ name: 'baseline-supervisor' }] }),
    )
    const scopes = await loadVerifyScopes(path)
    expect(scopes.map((s) => s.scope)).toEqual(['.'])
    expect(scopes[0].steps.map((s) => s.name)).toEqual([
      'typecheck',
      'test',
      'lint',
    ])
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
