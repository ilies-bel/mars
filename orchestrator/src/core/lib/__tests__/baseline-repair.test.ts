import { describe, expect, it, vi } from 'vitest'

import { createBaselineRepairer, type BaselineRepairDeps, type ExecResult } from '../baseline-repair'

/**
 * A minimal in-memory git + filesystem fake, just capable enough to drive
 * `createBaselineRepairer` through probe → resolve/repair → verify → commit
 * without a real repo. `files` is the working tree; `headSnapshot` is what
 * the last commit saw — `git status`/`diff --numstat` are derived from the
 * difference between them, exactly like a real checkout.
 */
const makeFakeRepo = (initialFiles: Record<string, string>) => {
  const files = new Map(Object.entries(initialFiles))
  const headSnapshot = new Map(files)
  const commits: string[] = ['0000000']

  const readFile = async (path: string): Promise<string> => {
    if (!files.has(path)) throw new Error(`ENOENT: ${path}`)
    return files.get(path) as string
  }
  const writeFile = async (path: string, content: string): Promise<void> => {
    files.set(path, content)
  }

  const git = async (argv: readonly string[]): Promise<ExecResult> => {
    const [cmd, ...rest] = argv
    if (cmd === 'rev-parse' && rest[0] === '--abbrev-ref') {
      return { exitCode: 0, stdout: 'main\n', stderr: '' }
    }
    if (cmd === 'rev-parse' && rest[0] === 'HEAD') {
      return { exitCode: 0, stdout: `${commits[commits.length - 1]}\n`, stderr: '' }
    }
    if (cmd === 'status') {
      const lines: string[] = []
      for (const [path, content] of files) {
        if (headSnapshot.get(path) !== content) lines.push(` M ${path}`)
      }
      return { exitCode: 0, stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '', stderr: '' }
    }
    if (cmd === 'ls-files') {
      return { exitCode: 0, stdout: `${[...headSnapshot.keys()].sort().join('\n')}\n`, stderr: '' }
    }
    if (cmd === 'diff' && rest[0] === '--numstat') {
      const lines: string[] = []
      for (const [path, content] of files) {
        if (headSnapshot.get(path) !== content) lines.push(`1\t1\t${path}`)
      }
      return { exitCode: 0, stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '', stderr: '' }
    }
    if (cmd === 'add') {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'commit') {
      for (const [path, content] of files) headSnapshot.set(path, content)
      commits.push(`commit-${commits.length}`)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'checkout') {
      const paths = rest.slice(1)
      for (const p of paths) {
        if (headSnapshot.has(p)) files.set(p, headSnapshot.get(p) as string)
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'clean') {
      const paths = rest.slice(2)
      for (const p of paths) files.delete(p)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  return { files, headSnapshot, readFile, writeFile, git }
}

const manifest = (deps: Record<string, string>): string =>
  JSON.stringify({ name: 'pkg', devDependencies: deps }, null, 2) + '\n'

describe('createBaselineRepairer — deterministic version-pin resolution', () => {
  it('resolves an unsatisfiable pin to the sibling-pinned version, verifies, and commits — the incident scenario', async () => {
    // packages/demo pins a version of @types/react-dom that was never
    // published; three sibling manifests already pin the correct one.
    const repo = makeFakeRepo({
      'packages/demo/package.json': manifest({ '@types/react-dom': '^18.3.18' }),
      'packages/a/package.json': manifest({ '@types/react-dom': '^18.3.5' }),
      'packages/b/package.json': manifest({ '@types/react-dom': '^18.3.5' }),
      'packages/c/package.json': manifest({ '@types/react-dom': '^18.3.5' }),
    })
    const publishedVersions = ['18.3.4', '18.3.5', '18.3.6']

    const probeInstall = async (): Promise<ExecResult> => {
      const demo = JSON.parse(await repo.readFile('packages/demo/package.json'))
      const range: string = demo.devDependencies['@types/react-dom']
      const version = range.replace(/^[\^~]/, '')
      if (publishedVersions.includes(version)) {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `npm error code ETARGET\nnpm error notarget No matching version found for @types/react-dom@${range}.`,
      }
    }

    const runAgentInPlace = vi.fn(async () => ({ exitCode: 0 }))
    const raise = vi.fn(async () => 'aq-1')
    const clearBaselinePause = vi.fn()
    const listPublishedVersions = vi.fn(async (pkg: string) =>
      pkg === '@types/react-dom' ? publishedVersions : [],
    )

    const deps: BaselineRepairDeps = {
      repoRoot: '/repo',
      integrationBranch: 'main',
      probeInstall,
      runAgentInPlace,
      git: repo.git,
      readFile: repo.readFile,
      writeFile: repo.writeFile,
      listPublishedVersions,
      raise,
      clearBaselinePause,
    }

    const outcome = await createBaselineRepairer(deps).repair()

    expect(outcome.status).toBe('repaired')
    if (outcome.status !== 'repaired') throw new Error('unreachable')
    expect(outcome.files).toContain('packages/demo/package.json')

    // The version came from the sibling pin, not a guess.
    const fixed = JSON.parse(await repo.readFile('packages/demo/package.json'))
    expect(fixed.devDependencies['@types/react-dom']).toBe('^18.3.5')

    // The class-of-defect agent was never invoked — the resolution was
    // entirely deterministic.
    expect(runAgentInPlace).not.toHaveBeenCalled()
    expect(clearBaselinePause).toHaveBeenCalledOnce()
    expect(raise).not.toHaveBeenCalled()
  })

  it('escalates rather than guessing when no satisfiable resolution exists', async () => {
    const repo = makeFakeRepo({
      'packages/demo/package.json': manifest({ '@types/react-dom': '^18.3.18' }),
    })
    // No sibling pin, and the registry lookup returns nothing usable.
    const probeInstall = async (): Promise<ExecResult> => ({
      exitCode: 1,
      stdout: '',
      stderr: 'npm error code ETARGET\nnpm error notarget No matching version found for @types/react-dom@^18.3.18.',
    })

    const runAgentInPlace = vi.fn(async () => ({ exitCode: 0 }))
    const raise = vi.fn(async () => 'aq-2')
    const clearBaselinePause = vi.fn()

    const deps: BaselineRepairDeps = {
      repoRoot: '/repo',
      integrationBranch: 'main',
      probeInstall,
      runAgentInPlace,
      git: repo.git,
      readFile: repo.readFile,
      writeFile: repo.writeFile,
      listPublishedVersions: vi.fn(async () => []),
      raise,
      clearBaselinePause,
    }

    const outcome = await createBaselineRepairer(deps).repair()

    expect(outcome.status).toBe('escalated')
    if (outcome.status !== 'escalated') throw new Error('unreachable')
    expect(outcome.refusal).toBe('unresolvable-version')

    // No guess was ever applied, and dispatch stays paused.
    const untouched = JSON.parse(await repo.readFile('packages/demo/package.json'))
    expect(untouched.devDependencies['@types/react-dom']).toBe('^18.3.18')
    expect(runAgentInPlace).not.toHaveBeenCalled()
    expect(clearBaselinePause).not.toHaveBeenCalled()
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ signature: 'baseline-repair/unresolvable-version' }),
    )
  })

  it('escalates when the offending pin cannot be located in any tracked manifest', async () => {
    const repo = makeFakeRepo({
      'package.json': manifest({ react: '^18.3.5' }),
    })
    const probeInstall = async (): Promise<ExecResult> => ({
      exitCode: 1,
      stdout: '',
      stderr: "error Couldn't find any versions for \"left-pad\" that matches \"^99.0.0\"",
    })

    const raise = vi.fn(async () => 'aq-3')
    const clearBaselinePause = vi.fn()
    const runAgentInPlace = vi.fn(async () => ({ exitCode: 0 }))

    const deps: BaselineRepairDeps = {
      repoRoot: '/repo',
      integrationBranch: 'main',
      probeInstall,
      runAgentInPlace,
      git: repo.git,
      readFile: repo.readFile,
      writeFile: repo.writeFile,
      listPublishedVersions: vi.fn(async () => ['1.0.0']),
      raise,
      clearBaselinePause,
    }

    const outcome = await createBaselineRepairer(deps).repair()

    expect(outcome.status).toBe('escalated')
    if (outcome.status !== 'escalated') throw new Error('unreachable')
    expect(outcome.refusal).toBe('unlocatable-manifest-pin')
    expect(runAgentInPlace).not.toHaveBeenCalled()
    expect(clearBaselinePause).not.toHaveBeenCalled()
  })

  it('still routes a non-version-pin install failure through the repair-agent path', async () => {
    const repo = makeFakeRepo({
      'package.json': manifest({ react: '^18.3.5' }),
      'package-lock.json': '{"lockfileVersion": 2}\n',
    })
    let installFailing = true
    const probeInstall = async (): Promise<ExecResult> =>
      installFailing
        ? { exitCode: 1, stdout: '', stderr: 'npm error code ENOTEMPTY\nnpm error syscall rmdir' }
        : { exitCode: 0, stdout: '', stderr: '' }

    const runAgentInPlace = vi.fn(async () => {
      // Simulate the Fixer reconciling the lockfile in place.
      await repo.writeFile('package-lock.json', '{"lockfileVersion": 3}\n')
      installFailing = false
      return { exitCode: 0 }
    })
    const clearBaselinePause = vi.fn()

    const deps: BaselineRepairDeps = {
      repoRoot: '/repo',
      integrationBranch: 'main',
      probeInstall,
      runAgentInPlace,
      git: repo.git,
      readFile: repo.readFile,
      writeFile: repo.writeFile,
      listPublishedVersions: vi.fn(async () => []),
      raise: vi.fn(async () => 'aq-4'),
      clearBaselinePause,
    }

    const outcome = await createBaselineRepairer(deps).repair()

    expect(outcome.status).toBe('repaired')
    expect(runAgentInPlace).toHaveBeenCalledOnce()
    expect(clearBaselinePause).toHaveBeenCalledOnce()
  })

  it('reports clean when the probe install already passes', async () => {
    const repo = makeFakeRepo({ 'package.json': manifest({ react: '^18.3.5' }) })
    const deps: BaselineRepairDeps = {
      repoRoot: '/repo',
      integrationBranch: 'main',
      probeInstall: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      runAgentInPlace: vi.fn(async () => ({ exitCode: 0 })),
      git: repo.git,
      readFile: repo.readFile,
      writeFile: repo.writeFile,
      listPublishedVersions: vi.fn(async () => []),
      raise: vi.fn(async () => 'aq-5'),
      clearBaselinePause: vi.fn(),
    }

    const outcome = await createBaselineRepairer(deps).repair()
    expect(outcome).toEqual({ status: 'clean' })
  })
})
