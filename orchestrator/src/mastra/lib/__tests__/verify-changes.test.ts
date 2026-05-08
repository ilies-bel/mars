import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { verifyChanges, loadVerifySteps, checkBranchHasDiff } from '../git'

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

describe('checkBranchHasDiff (empty-diff guard)', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-verify-diff-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'README'), 'hello\n')
    execFileSync('git', ['add', 'README'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', '-b', 'task/empty'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', '-b', 'task/with-commit', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'NEW'), 'new\n')
    execFileSync('git', ['add', 'NEW'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'add new'], { cwd: repo })
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns passed=false when the branch has no commits ahead of integration', async () => {
    const step = await checkBranchHasDiff(repo, 'task/empty', 'main')
    expect(step.name).toBe('has-diff')
    expect(step.passed).toBe(false)
    expect(step.output).toContain('no commits ahead')
  })

  it('returns passed=true when the branch has commits ahead', async () => {
    const step = await checkBranchHasDiff(repo, 'task/with-commit', 'main')
    expect(step.passed).toBe(true)
  })

  it('verifyChanges short-circuits when empty-diff guard fails', async () => {
    const r = await verifyChanges({
      cwd: repo,
      branch: 'task/empty',
      integrationBranch: 'main',
      steps: [{ name: 'should-not-run', ...truthyCmd, required: true }],
    })
    expect(r.passed).toBe(false)
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].name).toBe('has-diff')
  })
})

describe('loadVerifySteps', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(resolve(tmpdir(), 'mars-loadverify-'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('returns defaults when manifest is missing', async () => {
    const steps = await loadVerifySteps(resolve(workDir, 'nope.json'))
    expect(steps.map((s) => s.name)).toEqual(['typecheck', 'test', 'lint'])
  })

  it('returns defaults when manifest has no verify entries', async () => {
    const path = resolve(workDir, 'no-verify.json')
    writeFileSync(
      path,
      JSON.stringify({ supervisors: [{ name: 'baseline-supervisor' }] }),
    )
    const steps = await loadVerifySteps(path)
    expect(steps.map((s) => s.name)).toEqual(['typecheck', 'test', 'lint'])
  })

  it('returns the union of verify entries across supervisors, deduped by name', async () => {
    const path = resolve(workDir, 'union.json')
    writeFileSync(
      path,
      JSON.stringify({
        supervisors: [
          {
            name: 'node-backend-supervisor',
            verify: [
              { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
              { name: 'test', cmd: 'npm', args: ['test'], required: true },
            ],
          },
          {
            name: 'go-supervisor',
            verify: [
              { name: 'go-test', cmd: 'go', args: ['test', './...'], required: true },
              { name: 'typecheck', cmd: 'NEVER-WINS', args: [], required: true },
            ],
          },
        ],
      }),
    )
    const steps = await loadVerifySteps(path)
    const byName = new Map(steps.map((s) => [s.name, s]))
    expect(byName.size).toBe(steps.length)
    expect(byName.has('typecheck')).toBe(true)
    expect(byName.has('test')).toBe(true)
    expect(byName.has('go-test')).toBe(true)
  })

  it('prefers shallower scope when two supervisors disagree on the same step name', async () => {
    const path = resolve(workDir, 'scope.json')
    writeFileSync(
      path,
      JSON.stringify({
        supervisors: [
          {
            name: 'frontend-supervisor',
            scope: 'apps/web/frontend',
            verify: [{ name: 'test', cmd: 'deep', args: [], required: true }],
          },
          {
            name: 'root-supervisor',
            scope: '.',
            verify: [{ name: 'test', cmd: 'shallow', args: [], required: true }],
          },
        ],
      }),
    )
    const steps = await loadVerifySteps(path)
    const test = steps.find((s) => s.name === 'test')
    expect(test?.cmd).toBe('shallow')
  })
})
