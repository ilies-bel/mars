/**
 * Built-in verify heuristic: the TypeScript toolchain.
 *
 * Every `tsc`-shaped string the verify runner used to hard-code lives here
 * (TARGET §4.5) — the decoy marker, the `npx tsc` predicate, the pre-flight
 * toolchain-presence guard, the post-flight decoy guard and the dep-refresh
 * retry. Extracted verbatim from `core/lib/git/verify.ts`; the runner now asks
 * the heuristic registry instead of knowing any of it.
 *
 * All three hooks are pure decisions. This heuristic never records a step and
 * never re-runs one: it hands back a `PreStepDecision`, a `VerifyVerdict` or a
 * `RetryPlan`, and the runner applies it.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { classifyTypecheckOutput } from '../../../core/lib/failure-signature'
import type {
  HeuristicExec,
  PreStepDecision,
  RetryPlan,
  VerifyHeuristic,
  VerifyStepOutcome,
  VerifyStepRef,
  VerifyVerdict,
} from './types'

/**
 * The output marker emitted by the npm decoy `tsc` placeholder when `npx tsc`
 * is invoked without TypeScript properly installed. When this string appears
 * in a failing typecheck step's output, the step is a skip rather than a real
 * typecheck failure.
 */
export const TSC_DECOY_MARKER = 'This is not the tsc command you are looking for'

/** True when the step is an `npx tsc …` invocation. */
const isNpxTscStep = (step: VerifyStepRef): boolean =>
  step.cmd === 'npx' && step.args.length > 0 && step.args[0] === 'tsc'

/** Lockfile → frozen-install command, checked in the step dir then one level up. */
const LOCKFILE_INSTALLS: readonly (readonly [string, string, readonly string[]])[] = [
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
  ['package-lock.json', 'npm', ['ci']],
  ['yarn.lock', 'yarn', ['install', '--frozen-lockfile']],
  ['bun.lockb', 'bun', ['install', '--frozen-lockfile']],
]

export const typescriptToolchainHeuristic: VerifyHeuristic = {
  name: 'typescript-toolchain',

  /**
   * Pre-flight toolchain-presence guard: skip `npx tsc` steps when no real
   * TypeScript toolchain is detected in the step directory. A real toolchain
   * requires both a tsconfig.json (the project is configured for TypeScript)
   * and a locally-installed tsc binary. Without the local binary, `npx tsc`
   * resolves to the npm decoy package and emits the decoy marker rather than
   * running an actual typecheck. Skipping avoids a spurious required-step
   * failure in Kotlin/Gradle or other non-TypeScript repos.
   */
  beforeStep(step: VerifyStepRef, cwd: string): PreStepDecision | undefined {
    if (!isNpxTscStep(step)) return undefined

    const hasTsconfig = existsSync(resolve(cwd, 'tsconfig.json'))
    const hasWorkspaceManifest = existsSync(resolve(cwd, 'package.json'))
    const hasWorkspaceModules = existsSync(resolve(cwd, 'node_modules'))
    // Check both the step dir and one level up (workspace/monorepo hoist).
    const hasBin =
      existsSync(resolve(cwd, 'node_modules', '.bin', 'tsc')) ||
      existsSync(resolve(cwd, '..', 'node_modules', '.bin', 'tsc'))

    // A TypeScript workspace without its own module tree is not a
    // non-TypeScript project. It is a git-created/recreated worktree whose
    // dependencies were never provisioned. Fail before invoking tsc so the
    // operator sees the repair rather than TS2688 / TS2307 noise.
    if (hasTsconfig && hasWorkspaceManifest && !hasWorkspaceModules) {
      // stderr as well as output, so the message survives the structured
      // firstFailedOutput assembly in the `review` shell (which reads stderr
      // and stdout, not the combined output field, for steps that have a cmd).
      // Without it, classifyError sees only the step name as the first line
      // and falls through to `unclassified` instead of `typecheck-infra`.
      const depMsg =
        `worktree deps not provisioned: ${cwd}/node_modules is missing — ` +
        'run mars restart <task-id> to recreate the worktree with dependencies'
      return { passed: false, output: depMsg, stderr: depMsg }
    }

    if (!hasTsconfig || !hasBin) {
      return {
        passed: true,
        output: `typecheck skipped: no real TypeScript toolchain detected in ${cwd} (tsconfig.json present: ${hasTsconfig}, local tsc binary found: ${hasBin})`,
      }
    }

    return undefined
  },

  /**
   * Post-flight decoy guard: if `npx tsc` exited non-zero with the well-known
   * placeholder message, treat it as a skip rather than a code-level typecheck
   * failure. That is a misconfiguration signal — the TypeScript package is not
   * properly installed — not a type error the agent should try to fix.
   */
  classify(result: VerifyStepOutcome, step?: VerifyStepRef): VerifyVerdict | undefined {
    if (!step || !isNpxTscStep(step)) return undefined
    if (result.passed || !result.output.includes(TSC_DECOY_MARKER)) return undefined
    return {
      kind: 'skip',
      output: `typecheck skipped (decoy tsc detected — TypeScript not installed): ${result.output}`,
    }
  },

  /**
   * Infra-retry for tsc steps: if the failure contains no TypeScript error
   * codes, the environment is likely the culprit (missing modules, ENOENT,
   * OOM, …). Refresh dependencies and retry once. A real type error fails both
   * runs (a dep refresh cannot change compiled code), so one retry cannot mask
   * a genuine bug. Do NOT add a retry budget beyond one.
   */
  retry(result: VerifyStepOutcome, step: VerifyStepRef): RetryPlan | undefined {
    if (!isNpxTscStep(step)) return undefined
    if (result.passed || classifyTypecheckOutput(result.output) !== 'infra') return undefined

    return {
      name: 'typescript-toolchain/dep-refresh',

      // Best-effort dep refresh: detect the package manager from the lockfile
      // and run the frozen install command. Failure is silently ignored — the
      // retry will fail for the same reason and be recorded as infra.
      async prepare(exec: HeuristicExec, cwd: string): Promise<void> {
        for (const dir of [cwd, resolve(cwd, '..')]) {
          const hit = LOCKFILE_INSTALLS.find(([lockfile]) =>
            existsSync(resolve(dir, lockfile)),
          )
          if (!hit) continue
          const [, pm, installArgs] = hit
          try {
            await exec(pm, installArgs, cwd)
          } catch {
            // best-effort: ignore refresh failures; the retry decides the outcome
          }
          return
        }
      },

      // Retry also failed. Distinguish infra (no TS codes) from a real type
      // error revealed by the dep refresh (the refresh fixed the environment
      // and now tsc runs and reports real TS errors). Still infra ⇒ add the
      // sentinel so classifyError produces `typecheck-infra` rather than
      // `unclassified`; a real type error is recorded verbatim so the fix-task
      // recipe can address the actual TypeScript defect.
      afterRetry(retry: VerifyStepOutcome): { output: string; stderr: string } | undefined {
        if (classifyTypecheckOutput(retry.output) !== 'infra') return undefined
        const sentinel = `typecheck-infra: infra failure persisted after dep-refresh retry (exit ${retry.exitCode ?? 'null'})`
        return {
          output: sentinel + '\n' + retry.output,
          stderr: sentinel + (retry.stderr ? '\n' + retry.stderr : ''),
        }
      },
    }
  },
}
