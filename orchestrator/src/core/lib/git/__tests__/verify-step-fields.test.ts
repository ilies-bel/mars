/**
 * Tests that VerifyStep carries exitCode, stdout, and stderr alongside the
 * existing output string, so downstream failure-recording code can assemble
 * a full diagnostic block without re-merging the blobs.
 *
 * Also covers zero-step behavior (verify gates are opt-in):
 *   (a) empty changedFiles + zero steps passes.
 *   (b) non-empty changedFiles + zero steps ALSO passes — gates are optional.
 *   (c) non-empty changedFiles + at least one step runs the gate as before.
 *
 * Each test exercises the public verifyChanges API against real binaries
 * (`sh`, `sleep`) — no mocks of internal collaborators.
 */
import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { verifyChanges, SPEC_VERIFY_CMD_STEP } from '../verify'
import { computeFailureSignature } from '../../failure-signature'

describe('VerifyStep — exitCode / stdout / stderr fields', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('populates exitCode=0, stdout, stderr on a passing step', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-fields-pass-'))

    const result = await verifyChanges({
      cwd: tmpDir,
      steps: [
        {
          name: 'pass-step',
          // `sh -c 'echo hello'` emits to stdout, exits 0
          cmd: 'sh',
          args: ['-c', 'echo hello'],
          required: true,
        },
      ],
    })

    expect(result.passed).toBe(true)
    const step = result.steps.find((s) => s.name === 'pass-step')
    expect(step).toBeDefined()
    expect(step!.passed).toBe(true)

    // New fields must be present
    expect(step!.exitCode).toBe(0)
    expect(typeof step!.stdout).toBe('string')
    expect(typeof step!.stderr).toBe('string')
    // stdout should contain the echo output
    expect(step!.stdout).toContain('hello')
    // output (merged) must still work for existing callers
    expect(step!.output).toContain('hello')
  })

  it('populates exitCode, stdout, stderr on a failing step', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-fields-fail-'))

    const result = await verifyChanges({
      cwd: tmpDir,
      steps: [
        {
          name: 'fail-step',
          // `sh -c '...; exit 1'` emits to stderr, exits 1
          cmd: 'sh',
          args: ['-c', 'echo errout >&2; exit 1'],
          required: true,
        },
      ],
    })

    expect(result.passed).toBe(false)
    const step = result.steps.find((s) => s.name === 'fail-step')
    expect(step).toBeDefined()
    expect(step!.passed).toBe(false)

    // exitCode from the subprocess (not null)
    expect(step!.exitCode).toBe(1)
    expect(typeof step!.stdout).toBe('string')
    expect(step!.stderr).toContain('errout')
    // output (merged) must still contain the text
    expect(step!.output).toContain('errout')
  })

  it('classifies a verify child exiting 143 as SIGTERM, never as a typecheck failure', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-fields-sigterm-'))

    const result = await verifyChanges({
      cwd: tmpDir,
      steps: [
        {
          name: 'typecheck',
          cmd: 'node',
          args: ['-e', 'process.exit(143)'],
          required: true,
        },
      ],
    })

    const step = result.steps[0]!
    expect(step.exitCode).toBe(143)
    expect(computeFailureSignature('verify:typecheck', step.output)).toBe(
      'verify:killed/sigterm',
    )
  })

  it(
    'sets exitCode=null when the abort signal killed the step, and leaves stdout/stderr unprefixed',
    async () => {
      tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-fields-abort-'))

      const controller = new AbortController()
      const timeoutHandle = setTimeout(() => controller.abort(), 150)

      const result = await verifyChanges({
        cwd: tmpDir,
        signal: controller.signal,
        steps: [
          {
            name: 'abort-step',
            cmd: 'sleep',
            args: ['100'],
            required: true,
          },
        ],
      })
      clearTimeout(timeoutHandle)

      expect(result.passed).toBe(false)
      const step = result.steps.find((s) => s.name === 'abort-step')
      expect(step).toBeDefined()
      expect(step!.passed).toBe(false)

      // exitCode MUST be null (not the OS signal exit code) when abort fired
      expect(step!.exitCode).toBeNull()

      // output carries the human-readable "killed by abort signal" prefix
      expect(step!.output).toMatch(/abort|killed/i)

      // Raw stdout/stderr must NOT carry the abort-kill prefix message —
      // they contain only what the subprocess actually emitted (empty for sleep).
      expect(step!.stdout).not.toMatch(/abort|killed/i)
      expect(step!.stderr).not.toMatch(/abort|killed/i)
    },
    30_000,
  )
})

describe('VerifyStep — zero-step behavior (gates are optional)', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('(a) empty changedFiles + zero steps passes', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-preflight-empty-'))

    // Caller passes changedFiles: [] — no-op path passes cleanly.
    const result = await verifyChanges({
      cwd: tmpDir,
      steps: [],
      changedFiles: [],
    })

    expect(result.passed).toBe(true)
    expect(result.steps).toHaveLength(0)
  })

  it('(a2) undefined changedFiles + zero steps also passes', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-preflight-undef-'))

    // Main-committer and no-op callers pass no changedFiles at all.
    const result = await verifyChanges({
      cwd: tmpDir,
      steps: [],
    })

    expect(result.passed).toBe(true)
    expect(result.steps).toHaveLength(0)
  })

  it('(b) nonempty changedFiles + zero gates passes — gates are opt-in', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-preflight-noguard-'))

    // Verify gates are optional. A task with zero configured steps passes
    // the verify phase even when it changed files — the operator chooses
    // not to configure gates for this scope.
    const result = await verifyChanges({
      cwd: tmpDir,
      steps: [],
      changedFiles: ['src/foo.ts'],
    })

    expect(result.passed).toBe(true)
    expect(result.steps).toHaveLength(0)
  })

  it('(c) nonempty changedFiles + at least one gate runs the gate normally', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-preflight-gate-'))

    // With at least one step, the gate runs and determines the outcome.
    const result = await verifyChanges({
      cwd: tmpDir,
      steps: [
        {
          name: 'pass-gate',
          cmd: 'sh',
          args: ['-c', 'echo ok'],
          required: true,
        },
      ],
      changedFiles: ['src/foo.ts'],
    })

    expect(result.passed).toBe(true)
    const step = result.steps.find((s) => s.name === 'pass-gate')
    expect(step).toBeDefined()
    expect(step!.passed).toBe(true)
  })
})

describe('VerifyArgs.verifyCmd — spec-verify-cmd step contract', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runs the verifyCmd before registry steps and records it as SPEC_VERIFY_CMD_STEP', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-cmd-pass-'))

    const result = await verifyChanges({
      cwd: tmpDir,
      verifyCmd: 'echo spec-cmd-ran',
      steps: [
        {
          name: 'registry-gate',
          cmd: 'sh',
          args: ['-c', 'echo registry-ran'],
          required: true,
        },
      ],
    })

    expect(result.passed).toBe(true)
    // spec-verify-cmd step must appear before the registry step
    const specStep = result.steps.find((s) => s.name === SPEC_VERIFY_CMD_STEP)
    const registryStep = result.steps.find((s) => s.name === 'registry-gate')
    expect(specStep).toBeDefined()
    expect(registryStep).toBeDefined()
    expect(result.steps.indexOf(specStep!)).toBeLessThan(result.steps.indexOf(registryStep!))
    // spec step passed
    expect(specStep!.passed).toBe(true)
    expect(specStep!.exitCode).toBe(0)
  })

  it('commandLine on the spec-verify-cmd step is the raw command, not "sh -c <cmd>"', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-cmd-cmdline-'))

    const rawCmd = 'echo hello-from-spec'
    const result = await verifyChanges({
      cwd: tmpDir,
      verifyCmd: rawCmd,
      steps: [],
    })

    const specStep = result.steps.find((s) => s.name === SPEC_VERIFY_CMD_STEP)
    expect(specStep).toBeDefined()
    // commandLine must be the raw command string the task author wrote
    expect(specStep!.commandLine).toBe(rawCmd)
    // must NOT expose the sh -c shell wrapper as the displayable command
    expect(specStep!.commandLine).not.toMatch(/^sh -c/)
  })

  it('records exitCode faithfully when verifyCmd fails', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-cmd-fail-'))

    const result = await verifyChanges({
      cwd: tmpDir,
      verifyCmd: 'exit 42',
      steps: [
        {
          name: 'should-not-run',
          cmd: 'sh',
          args: ['-c', 'echo registry'],
          required: true,
        },
      ],
    })

    expect(result.passed).toBe(false)
    expect(result.verdict).toBe('FAIL')

    const specStep = result.steps.find((s) => s.name === SPEC_VERIFY_CMD_STEP)
    expect(specStep).toBeDefined()
    expect(specStep!.passed).toBe(false)
    expect(specStep!.exitCode).toBe(42)

    // registry step must NOT have run — verifyCmd failure is a hard stop
    const registryStep = result.steps.find((s) => s.name === 'should-not-run')
    expect(registryStep).toBeUndefined()
  })

  it('skips the spec-verify-cmd step when verifyCmd is null or empty', async () => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-cmd-empty-'))

    for (const verifyCmd of [null, '', '   ']) {
      const result = await verifyChanges({
        cwd: tmpDir,
        verifyCmd,
        steps: [],
      })
      const specStep = result.steps.find((s) => s.name === SPEC_VERIFY_CMD_STEP)
      expect(specStep).toBeUndefined()
    }
  })
})
