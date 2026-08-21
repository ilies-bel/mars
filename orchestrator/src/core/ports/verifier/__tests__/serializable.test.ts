/**
 * The Port acceptance test for the Verifier Port (ADR-0097): a
 * `VerifierRunArgs` survives `JSON.parse(JSON.stringify(...))` without loss,
 * and so does the `VerifierRunResult` that comes back. That round-trip is
 * what makes a future out-of-process implementation (e.g. "verify in CI"
 * over HTTP) a drop-in registration rather than a redesign.
 *
 * Plus the registry contract mirrored from `../code-index/__tests__`:
 * built-in registration, require-throws-naming-known-kinds, and env-driven
 * resolution through the shared Port catalog.
 */
import { describe, expect, it } from 'vitest'
import {
  getVerifier,
  listVerifiers,
  registerVerifier,
  requireVerifier,
  resolveVerifier,
} from '../registry'
import { localSubprocessVerifier } from '../local-subprocess'
import type { Verifier, VerifierRunArgs, VerifierRunResult } from '../types'

/**
 * An args object populated in every optional member, so the round-trip below
 * is a real test of the whole shape rather than of the two required fields.
 */
const fullArgs: VerifierRunArgs = {
  cwd: '/tmp/worktree',
  steps: [
    {
      name: 'typecheck',
      gateId: 'gate-1',
      cmd: 'npm',
      args: ['run', 'typecheck'],
      required: true,
      dir: 'orchestrator',
      tier: 'task',
      timeoutMin: 5,
    },
    {
      name: 'spec-verify-cmd',
      cmd: 'bash',
      args: ['-o', 'pipefail', '-c', 'npm run knip'],
      required: true,
      tier: 'task',
    },
  ],
  branch: 'task/mars-e8d0c4d6',
  integrationBranch: 'main',
  changedFiles: ['orchestrator/src/core/ports/verifier/types.ts'],
  verifyCmd: 'npm run knip',
  modelAttribution: { provider: 'codex', model: 'gpt-5.6-sol' },
}

describe('VerifierRunArgs is serializable', () => {
  it('round-trips through JSON.parse(JSON.stringify(args)) without loss', () => {
    const roundTripped = JSON.parse(JSON.stringify(fullArgs)) as VerifierRunArgs
    expect(roundTripped).toEqual(fullArgs)
  })

  it('drops no key on the way through JSON', () => {
    const roundTripped = JSON.parse(JSON.stringify(fullArgs)) as VerifierRunArgs
    expect(Object.keys(roundTripped).sort()).toEqual(Object.keys(fullArgs).sort())
    // A function-valued or handle-valued member would vanish here; every step
    // spec must survive intact, nested arrays included.
    expect(roundTripped.steps).toHaveLength(fullArgs.steps.length)
    expect(roundTripped.steps[0]?.args).toEqual(['run', 'typecheck'])
  })

  it('round-trips a VerifierRunResult without loss', () => {
    const result: VerifierRunResult = {
      passed: false,
      verdict: 'FAIL',
      steps: [
        {
          name: 'typecheck',
          gateId: 'gate-1',
          passed: false,
          output: 'error TS2307',
          cmd: 'npm',
          args: ['run', 'typecheck'],
          stepDir: '/tmp/worktree/orchestrator',
          tier: 'task',
          duration: 1234,
          exitCode: 2,
          stdout: 'error TS2307',
          stderr: '',
          commandLine: 'npm run typecheck',
        },
      ],
      modelAttribution: { provider: 'codex', model: 'gpt-5.6-sol' },
    }
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })
})

describe('built-in registration', () => {
  it('registers the local implementation at import time', () => {
    expect(listVerifiers().map((impl) => impl.kind)).toContain('local')
  })

  it('getVerifier resolves the built-in by kind', () => {
    expect(getVerifier('local')).toBe(localSubprocessVerifier)
  })

  it('getVerifier returns undefined for an unregistered kind', () => {
    expect(getVerifier('nope')).toBeUndefined()
  })

  it('requireVerifier throws naming the known kinds for an unregistered kind', () => {
    expect(() => requireVerifier('nope')).toThrow(/Unknown Verifier implementation 'nope'/)
    expect(() => requireVerifier('nope')).toThrow(/local/)
  })
})

describe('registerVerifier()', () => {
  it('registers a new implementation and the returned disposer withdraws it', async () => {
    const fake: Verifier = {
      kind: 'test-fake',
      async run(args: VerifierRunArgs): Promise<VerifierRunResult> {
        return { passed: true, verdict: 'PASS', steps: [], modelAttribution: args.modelAttribution }
      },
    }
    const dispose = registerVerifier(fake)
    expect(getVerifier('test-fake')).toBe(fake)
    await expect(fake.run(fullArgs)).resolves.toMatchObject({ passed: true, verdict: 'PASS' })
    dispose()
    expect(getVerifier('test-fake')).toBeUndefined()
  })
})

describe('resolveVerifier()', () => {
  it('defaults to the local implementation when the env var is unset', () => {
    expect(resolveVerifier({})).toBe(localSubprocessVerifier)
  })

  it('defaults to local when the env var is empty', () => {
    expect(resolveVerifier({ MARS_VERIFIER_KIND: '' })).toBe(localSubprocessVerifier)
  })

  it('throws when the env var names a kind the shared Port registry does not declare', () => {
    expect(() => resolveVerifier({ MARS_VERIFIER_KIND: 'bogus' })).toThrow(
      /not a registered implementation/,
    )
  })

  it('throws when a declared kind has no implementation registered here', () => {
    // `remote-http` is declared in the shared Port catalog but its adapter is
    // a later slice — resolution must surface that, not silently fall back.
    expect(() => resolveVerifier({ MARS_VERIFIER_KIND: 'remote-http' })).toThrow(
      /Unknown Verifier implementation 'remote-http'/,
    )
  })
})
