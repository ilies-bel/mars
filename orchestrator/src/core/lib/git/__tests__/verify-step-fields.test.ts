/**
 * Tests that VerifyStep carries exitCode, stdout, and stderr alongside the
 * existing output string, so downstream failure-recording code can assemble
 * a full diagnostic block without re-merging the blobs.
 *
 * Each test exercises the public verifyChanges API against real binaries
 * (`true` / `false` / `sleep`) — no mocks of internal collaborators.
 */
import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { verifyChanges } from '../verify'

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
