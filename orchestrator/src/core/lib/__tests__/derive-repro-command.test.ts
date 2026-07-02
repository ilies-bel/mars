import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  deriveReproCommand,
  resolveVerifyCwd,
  buildVerifyReproHint,
  type RanVerifyStep,
} from '../derive-repro-command'

describe('deriveReproCommand', () => {
  let worktree: string

  beforeEach(() => {
    worktree = mkdtempSync(resolve(tmpdir(), 'mars-derive-repro-'))
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
  })

  describe('verify:test', () => {
    it('prefers `npm test` when a test script exists in package.json', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && npm test`)
    })

    it('uses `pnpm test` when a pnpm-lock.yaml is present alongside the script', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && pnpm test`)
    })

    it('uses `yarn test` when a yarn.lock is present alongside the script', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'yarn.lock'), '')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && yarn test`)
    })

    it('uses `bun test` when a bun.lockb is present alongside the script', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'bun.lockb'), '')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && bun test`)
    })

    it('uses `bun test` when a bun.lock is present alongside the script', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'bun.lock'), '')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && bun test`)
    })

    it('uses `npm test` when a package-lock.json is present alongside the script', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'package-lock.json'), '{}')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && npm test`)
    })

    it('returns null when the test script value is an empty string (cannot infer runner for non-JS repos)', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: '' } }),
      )
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBeNull()
    })

    it('prefers pnpm over yarn when both lockfiles are present', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      writeFileSync(resolve(worktree, 'yarn.lock'), '# yarn lockfile v1\n')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && pnpm test`)
    })

    it('returns null when package.json has no test script (non-JS repo fallback)', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { build: 'tsc' } }),
      )
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBeNull()
    })

    it('returns null when package.json is missing entirely (non-JS repo — e.g. Gradle)', () => {
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBeNull()
    })

    it('returns null when package.json is malformed', () => {
      writeFileSync(resolve(worktree, 'package.json'), '{ not json')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBeNull()
    })
  })

  describe('verify:typecheck', () => {
    it('returns `npx tsc -p .` regardless of package.json state', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      expect(deriveReproCommand('verify:typecheck', worktree)).toBe(
        `cd ${worktree} && npx tsc -p .`,
      )
    })

    it('returns `npx tsc -p .` even with no package.json', () => {
      expect(deriveReproCommand('verify:typecheck', worktree)).toBe(
        `cd ${worktree} && npx tsc -p .`,
      )
    })
  })

  describe('unknown / unsupported failing step', () => {
    it('returns null for unrelated steps like `setup:install`', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      expect(deriveReproCommand('setup:install', worktree)).toBeNull()
    })

    it('returns null when worktreePath is null', () => {
      expect(deriveReproCommand('verify:test', null)).toBeNull()
      expect(deriveReproCommand('verify:typecheck', null)).toBeNull()
    })
  })

  describe('nested project layout (project lives under <worktree>/orchestrator)', () => {
    // Mirrors this repo's layout: the worktree root only declares
    // dependencies; the test runner and tsconfig live in `orchestrator/`.
    // The repro command must `cd` into the subproject or it will not
    // reproduce the verify failure.
    const seedNested = () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ dependencies: {} }),
      )
      const sub = resolve(worktree, 'orchestrator')
      mkdirSync(sub)
      writeFileSync(
        resolve(sub, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
      return sub
    }

    it('cd-s into the orchestrator subproject for verify:test', () => {
      const sub = seedNested()
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${sub} && npm test`)
    })

    it('cd-s into the orchestrator subproject for verify:typecheck', () => {
      const sub = seedNested()
      const cmd = deriveReproCommand('verify:typecheck', worktree)
      expect(cmd).toBe(`cd ${sub} && npx tsc -p .`)
    })

    it('still picks the root when it owns both package.json and tsconfig.json', () => {
      writeFileSync(
        resolve(worktree, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(worktree, 'tsconfig.json'), '{}')
      // The nested orchestrator dir also looks like a project, but root
      // wins because resolveVerifyCwd checks it first.
      const sub = resolve(worktree, 'orchestrator')
      mkdirSync(sub)
      writeFileSync(
        resolve(sub, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest run' } }),
      )
      writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
      const cmd = deriveReproCommand('verify:test', worktree)
      expect(cmd).toBe(`cd ${worktree} && npm test`)
    })
  })

  describe('resolveVerifyCwd', () => {
    it('returns the worktree root when it has both package.json and tsconfig.json', () => {
      writeFileSync(resolve(worktree, 'package.json'), '{}')
      writeFileSync(resolve(worktree, 'tsconfig.json'), '{}')
      expect(resolveVerifyCwd(worktree)).toBe(worktree)
    })

    it('falls back to <root>/orchestrator when the root is missing tsconfig.json', () => {
      writeFileSync(resolve(worktree, 'package.json'), '{}')
      const sub = resolve(worktree, 'orchestrator')
      mkdirSync(sub)
      writeFileSync(resolve(sub, 'package.json'), '{}')
      writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
      expect(resolveVerifyCwd(worktree)).toBe(sub)
    })

    it('returns the worktree root unchanged when no project layout is found', () => {
      expect(resolveVerifyCwd(worktree)).toBe(worktree)
    })

    it('uses verifyCwd from manifest when the TS heuristic finds no project (non-JS repo)', () => {
      // Non-JS layout: no package.json/tsconfig.json anywhere.
      // The manifest has exactly one non-root supervisor with verifyCwd set.
      const marsDir = resolve(worktree, '.mars', 'supervisors')
      mkdirSync(marsDir, { recursive: true })
      writeFileSync(
        resolve(marsDir, 'manifest.json'),
        JSON.stringify({
          version: 1,
          supervisors: [
            { name: 'backend', scope: 'service-a', verifyCwd: 'service-a' },
          ],
          removed: [],
        }),
      )
      expect(resolveVerifyCwd(worktree)).toBe(resolve(worktree, 'service-a'))
    })

    it('ignores the manifest when multiple distinct verifyCwds exist (ambiguous multi-supervisor)', () => {
      const marsDir = resolve(worktree, '.mars', 'supervisors')
      mkdirSync(marsDir, { recursive: true })
      writeFileSync(
        resolve(marsDir, 'manifest.json'),
        JSON.stringify({
          version: 1,
          supervisors: [
            { name: 'svc-a', scope: 'service-a', verifyCwd: 'service-a' },
            { name: 'svc-b', scope: 'service-b', verifyCwd: 'service-b' },
          ],
          removed: [],
        }),
      )
      // Falls back to worktree root — no TS project, no unambiguous manifest cwd.
      expect(resolveVerifyCwd(worktree)).toBe(worktree)
    })

    it('TS heuristic takes priority over manifest when the root is itself a TS project', () => {
      // Root has package.json + tsconfig.json → TS check fires before manifest lookup.
      writeFileSync(resolve(worktree, 'package.json'), '{}')
      writeFileSync(resolve(worktree, 'tsconfig.json'), '{}')
      const marsDir = resolve(worktree, '.mars', 'supervisors')
      mkdirSync(marsDir, { recursive: true })
      writeFileSync(
        resolve(marsDir, 'manifest.json'),
        JSON.stringify({
          version: 1,
          supervisors: [
            {
              name: 'orchestrator',
              scope: 'orchestrator',
              verifyCwd: 'orchestrator',
            },
          ],
          removed: [],
        }),
      )
      expect(resolveVerifyCwd(worktree)).toBe(worktree)
    })

    it('ignores root-scoped supervisor (scope ".") when looking for manifest override', () => {
      const marsDir = resolve(worktree, '.mars', 'supervisors')
      mkdirSync(marsDir, { recursive: true })
      writeFileSync(
        resolve(marsDir, 'manifest.json'),
        JSON.stringify({
          version: 1,
          supervisors: [{ name: 'root', scope: '.', verifyCwd: '.' }],
          removed: [],
        }),
      )
      expect(resolveVerifyCwd(worktree)).toBe(worktree)
    })

    it('tolerates a manifest with no verifyCwd fields and falls back to TS heuristic', () => {
      const marsDir = resolve(worktree, '.mars', 'supervisors')
      mkdirSync(marsDir, { recursive: true })
      writeFileSync(
        resolve(marsDir, 'manifest.json'),
        JSON.stringify({
          version: 1,
          // No verifyCwd field on any entry — older manifest format.
          supervisors: [{ name: 'backend', scope: 'orchestrator' }],
          removed: [],
        }),
      )
      const sub = resolve(worktree, 'orchestrator')
      mkdirSync(sub)
      writeFileSync(resolve(sub, 'package.json'), '{}')
      writeFileSync(resolve(sub, 'tsconfig.json'), '{}')
      expect(resolveVerifyCwd(worktree)).toBe(sub)
    })
  })
})

describe('buildVerifyReproHint', () => {
  it('returns null for an empty steps array', () => {
    expect(buildVerifyReproHint([])).toBeNull()
  })

  it('shows the command and directory for a single failing non-JavaScript step', () => {
    const steps: RanVerifyStep[] = [
      { name: 'test', cmd: 'pytest', args: ['src/'], stepDir: '/repo/api', passed: false },
    ]
    expect(buildVerifyReproHint(steps)).toBe(
      'cd /repo/api && pytest src/  # test (FAILED)',
    )
  })

  it('lists all steps that actually ran, annotating each as passed or FAILED', () => {
    const steps: RanVerifyStep[] = [
      {
        name: 'typecheck',
        cmd: 'npx',
        args: ['tsc', '--noEmit'],
        stepDir: '/repo/frontend',
        passed: true,
      },
      { name: 'test', cmd: 'pytest', args: [], stepDir: '/repo/api', passed: false },
    ]
    expect(buildVerifyReproHint(steps)).toBe(
      'cd /repo/frontend && npx tsc --noEmit  # typecheck (passed)\n' +
        'cd /repo/api && pytest  # test (FAILED)',
    )
  })

  it('keeps the failing step identifiable via the FAILED annotation', () => {
    const steps: RanVerifyStep[] = [
      { name: 'build', cmd: 'cargo', args: ['build'], stepDir: '/repo', passed: false },
    ]
    const hint = buildVerifyReproHint(steps)
    expect(hint).toContain('FAILED')
    expect(hint).toContain('build')
    expect(hint).toContain('cargo build')
  })

  it('uses no hardcoded JavaScript commands when the declared steps use a different toolchain', () => {
    const steps: RanVerifyStep[] = [
      { name: 'test', cmd: 'pytest', args: ['tests/'], stepDir: '/repo', passed: false },
    ]
    const hint = buildVerifyReproHint(steps)
    expect(hint).not.toContain('npx')
    expect(hint).not.toContain('vitest')
    expect(hint).not.toContain('tsc')
    expect(hint).not.toContain('npm')
  })

  it('uses the scope directory declared in the failing step, not a hardcoded cwd', () => {
    const steps: RanVerifyStep[] = [
      {
        name: 'test',
        cmd: 'pytest',
        args: [],
        stepDir: '/worktree/apps/api',
        passed: false,
      },
    ]
    const hint = buildVerifyReproHint(steps)
    expect(hint).toContain('cd /worktree/apps/api')
  })
})
