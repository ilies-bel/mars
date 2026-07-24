/**
 * Tests that verifyChanges aborts a hanging step when the caller's AbortSignal
 * fires, records the step as failed with a clear timeout message, and resolves
 * promptly rather than hanging until the outer merge watchdog fires.
 *
 * This covers the integration-gate timeout path:
 *   integrationGateRunner (primitives/index.ts) creates an AbortController,
 *   arms a timer at INTEGRATION_GATE_TIMEOUT_MS (~120s), and passes the signal
 *   into verifyChanges so a hung gate command is killed before the 300s merge
 *   watchdog. The tests here verify the verifyChanges / runVerifyStep plumbing
 *   without the full primitives stack.
 */
import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { verifyChanges } from '../verify'

describe('verifyChanges — signal abort', () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it(
    'aborts a hanging step when the signal fires and records it as passed:false with a timeout message',
    async () => {
      tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-signal-'))

      const controller = new AbortController()
      // Fire the abort after 150ms — fast enough to test without slowing the suite.
      const timeoutHandle = setTimeout(() => controller.abort(), 150)

      const start = Date.now()
      const result = await verifyChanges({
        cwd: tmpDir,
        signal: controller.signal,
        steps: [
          {
            name: 'hang-step',
            cmd: 'sleep',
            args: ['100'],
            required: true,
          },
        ],
      })
      clearTimeout(timeoutHandle)
      const elapsed = Date.now() - start

      // Must resolve fast (well under the 30s test timeout) rather than
      // hanging until the outer 300s merge watchdog fires.
      expect(elapsed).toBeLessThan(5_000)

      expect(result.passed).toBe(false)
      const step = result.steps.find((s) => s.name === 'hang-step')
      expect(step).toBeDefined()
      expect(step!.passed).toBe(false)

      // The step output must name the abort/timeout so post-mortems can tell
      // a timeout-kill apart from a genuine test failure.
      expect(step!.output).toMatch(/abort|killed|timed?\s*out/i)
    },
    30_000,
  )

  it(
    'records a step as failed immediately when the signal is already aborted before the step starts',
    async () => {
      tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-signal-pre-'))

      // Pre-abort the controller so the signal is already fired before verifyChanges runs.
      const controller = new AbortController()
      controller.abort()

      const start = Date.now()
      const result = await verifyChanges({
        cwd: tmpDir,
        signal: controller.signal,
        steps: [
          {
            name: 'step-never-runs',
            cmd: 'sleep',
            args: ['100'],
            required: true,
          },
        ],
      })
      const elapsed = Date.now() - start

      // Should resolve almost instantly — no subprocess was spawned.
      expect(elapsed).toBeLessThan(2_000)
      expect(result.passed).toBe(false)

      const step = result.steps.find((s) => s.name === 'step-never-runs')
      expect(step).toBeDefined()
      expect(step!.passed).toBe(false)
      expect(step!.output).toMatch(/abort|killed|timed?\s*out/i)
    },
    30_000,
  )
})
