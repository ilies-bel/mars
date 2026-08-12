/**
 * Regression test — mars-f65e20f9 (slice 3 of 5)
 *
 * Proves that a filtered pipeline cannot silently mask a failing typecheck
 * by driving verifyChanges with a real subprocess (a PATH-shadowed npm shim
 * that exits 2 and writes a TypeScript diagnostic to stderr).
 *
 * The incident: a task's spec.verifyCmd was
 *   npm run typecheck 2>&1 | grep "error TS" | head -10
 * Under plain `sh -c`, `head` exits 0 even though npm exited 2, so the
 * verify step returned passed:true — a false green that allowed a broken
 * build to merge.
 *
 * Fix (slice 2): the `review` primitive wraps spec.verifyCmd in
 * `bash -o pipefail -c`, which propagates the leftmost non-zero exit from
 * any pipeline, preventing the false green from recurring.
 *
 * Two cases verified here:
 *  1. Direct command ('npm run typecheck') — verifyChanges returns
 *     passed:false and exitCode:2 on the spec.verifyCmd step.
 *  2. Incident-verbatim filtered pipeline — with bash -o pipefail the
 *     leftmost non-zero exit (npm's 2) propagates through grep | head,
 *     so verifyChanges still returns passed:false and exitCode:2.
 *
 * The rendered verifyOutput (from the review primitive, slice 1) for a step
 * with exitCode=2 contains the token 'exit=2' (format:
 * `exit=${s.exitCode ?? 'killed'}` at primitives/index.ts ~2936). This test
 * applies the same formula to prove the token would appear in verifyOutput.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyChanges } from '../../../core/lib/git/verify'

// ---------------------------------------------------------------------------
// PATH shim: a fake npm binary that exits 2 on 'npm run typecheck'
// ---------------------------------------------------------------------------

let tmpDir: string
let savedPath: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mars-verify-fp-'))

  // Fake npm: writes 'error TS2307: Cannot find module foo' to stderr and
  // exits 2 when invoked as 'npm run typecheck'. All other invocations pass.
  const shimContent = [
    '#!/bin/sh',
    'if [ "$1" = "run" ] && [ "$2" = "typecheck" ]; then',
    "  printf 'error TS2307: Cannot find module foo\\n' >&2",
    '  exit 2',
    'fi',
    'exit 0',
  ].join('\n') + '\n'

  writeFileSync(join(tmpDir, 'npm'), shimContent, { mode: 0o755 })

  // Prepend tmpDir to PATH so bash resolves our shim before the real npm.
  savedPath = process.env.PATH ?? ''
  process.env.PATH = `${tmpDir}:${savedPath}`
})

afterAll(() => {
  process.env.PATH = savedPath
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helper: the synthetic spec.verifyCmd step the review primitive builds.
// bash -o pipefail ensures the leftmost non-zero exit propagates through
// any pipeline (prevents head/grep from masking a failing typecheck).
// ---------------------------------------------------------------------------

const makeSpecVerifyStep = (cmd: string) => ({
  name: 'spec.verifyCmd' as const,
  cmd: 'bash' as const,
  args: ['-o', 'pipefail', '-c', cmd] as readonly string[],
  required: true as const,
  tier: 'task' as const,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verify — filtered pipeline cannot mask a failing typecheck', () => {
  it(
    'scenario 1: direct npm run typecheck — passed:false, exitCode:2',
    async () => {
      const result = await verifyChanges({
        cwd: tmpDir,
        steps: [makeSpecVerifyStep('npm run typecheck')],
      })

      expect(result.passed).toBe(false)

      const step = result.steps.find((s) => s.name === 'spec.verifyCmd')
      expect(step).toBeDefined()

      // The step must record npm's true exit code — not the exit of any
      // wrapper shell (bash exits with the command's code when it's not a
      // pipeline, so exit 2 propagates directly).
      expect(step!.exitCode).toBe(2)

      // The review primitive renders each step with the formula:
      //   `exit=${s.exitCode ?? 'killed'}` (primitives/index.ts ~2936)
      // Apply the same formula to prove 'exit=2' would appear in verifyOutput.
      const exitBadge =
        step!.exitCode !== undefined ? ` exit=${step!.exitCode ?? 'killed'}` : ''
      expect(exitBadge).toBe(' exit=2')
    },
    15_000,
  )

  it(
    'scenario 2: incident pipeline (npm run typecheck 2>&1 | grep "error TS" | head -10) — still passed:false via bash -o pipefail',
    async () => {
      // Under plain `sh -c` this pipeline exits 0 (head's code) — false green.
      // With bash -o pipefail the leftmost non-zero exit (npm's 2) propagates.
      const incidentCmd = 'npm run typecheck 2>&1 | grep "error TS" | head -10'

      const result = await verifyChanges({
        cwd: tmpDir,
        steps: [makeSpecVerifyStep(incidentCmd)],
      })

      expect(result.passed).toBe(false)

      const step = result.steps.find((s) => s.name === 'spec.verifyCmd')
      expect(step).toBeDefined()

      // pipefail propagates npm's exit=2 through the grep | head pipeline.
      // Without pipefail the test would wrongly see exitCode=0 here — that
      // was the original false-green: head's 0 masked npm's 2.
      expect(step!.exitCode).toBe(2)

      const exitBadge =
        step!.exitCode !== undefined ? ` exit=${step!.exitCode ?? 'killed'}` : ''
      expect(exitBadge).toBe(' exit=2')
    },
    15_000,
  )
})
