/**
 * The canonical registry of every user-updatable Mars parameter (lever).
 *
 * Each entry describes a tuneable aspect of the orchestrator — its current
 * value, how it may be changed, which command (if any) applies the change,
 * and whether a restart is required.
 *
 * Improvement recipes (formerly improvement-recipes.ts) are folded in here as
 * entries in the 'verify' family. No parallel catalog exists.
 *
 * Levers with `gesture: null` are the documented gaps — readable from
 * `.mars/daemon.json` but not yet settable through any `mars` command. The
 * follow-up slice builds those gestures.
 *
 * Wiring state: each entry carries an optional `consumer` field pointing at
 * the production file+symbol that reads the lever's value to alter runtime
 * behaviour. Entries without a declared consumer render as `no-consumer` —
 * meaning either the feature is not yet wired, or the lever's value is stored
 * but nothing acts on it. The build-enforcing test in lever-registry.test.ts
 * verifies every declared consumer reference actually exists in the codebase.
 */

import {
  loadDaemonConfig,
  readAutotuneMaxImplement,
  readControlLevers,
  readLeverAutonomyLevel,
  readPersistedPaused,
} from '../daemon/config'
import { STEWARD_RUNTIME_TUNE_LEVER } from './conversation-copy'
import { readBudgetConfig } from './spend-meter'

export type LeverFamily =
  | 'model'
  | 'provider'
  | 'workflow'
  | 'verify'
  | 'concurrency'
  | 'operator'
  | 'budget'
  | 'scoring'
  | 'self-evolve'
  | 'task-spec'

type LeverScope = 'global' | 'per-workflow' | 'per-task'

/**
 * The wiring state of a lever — whether its value is actually read by
 * production code to alter runtime behaviour.
 *
 * - `wired`       — a declared consumer exists and reads this value at runtime.
 * - `no-gesture`  — a consumer exists but no CLI verb can set it yet.
 * - `no-consumer` — no production code reads this lever's value; changes have
 *                   no effect until the feature is wired.
 */
export type LeverWiringState = 'wired' | 'no-gesture' | 'no-consumer'

/**
 * A reference to the production code that reads a lever's value.
 *
 * `file` is relative to the orchestrator root (e.g. `src/core/daemon/server.ts`).
 * `symbol` is the function name or export that reads the config value.
 *
 * The build-enforcing test in `lever-registry.test.ts` verifies that every
 * declared consumer reference points to an existing file containing the named
 * symbol. An entry whose declared consumer doesn't exist will fail the build.
 */
interface LeverConsumerRef {
  file: string
  symbol: string
}

interface AllowedEnum {
  type: 'enum'
  values: readonly string[]
}
interface AllowedRange {
  type: 'range'
  min: number
  max?: number
}
interface AllowedFreeform {
  type: 'freeform'
}
type AllowedValues = AllowedEnum | AllowedRange | AllowedFreeform

/**
 * Recipe metadata for verify-family levers, folded in from the former
 * improvement-recipes.ts. Only verify-family entries carry this field.
 */
export interface RecipeMetadata {
  triggerPattern: string
  problem: string
  solution: string
  setupSteps: string[]
  verifyGate?: { name: string; cmd: string; args: string[]; scope?: string }
  maturityLevel: 'bare' | 'typecheck' | 'tests' | 'e2e'
}

/**
 * The effective live value of a lever in a running daemon, which may diverge
 * from the persisted config (e.g. steward autotune raising `implementCap`
 * in-process). Returned by `LeverRegistryEntry.readEffective`.
 */
interface EffectiveRead {
  effective: string
  reason: string | null
}

/**
 * Minimal daemon interface needed to query live lever state.
 *
 * The production `DaemonClient` from `src/cli/command.ts` satisfies this
 * structurally — its `sendRequest` accepts `DaemonRequest` (a union that
 * includes `{ op: 'status' }`), and TypeScript's bivariant method checking
 * allows assigning it here. Tests use `makeFakeDaemon` from `test-adapter.ts`
 * which also satisfies the interface.
 */
export interface CapQuerier {
  sendRequest(req: { op: 'status' }): Promise<unknown>
}

export interface LeverRegistryEntry {
  id: string
  label: string
  family: LeverFamily
  scope: LeverScope
  /**
   * Returns the persisted (configured) value as a human-readable string.
   * Returns null when the value cannot be determined without a daemon or DB
   * connection (e.g. active verify gates, worker registry).
   *
   * This reflects what is stored in `.mars/daemon.json` — NOT necessarily
   * what is in force. For the live effective value, see `readEffective`.
   */
  readCurrent(): string | null
  /**
   * Optional async query for the live effective value from a running daemon.
   * The effective value may differ from `readCurrent()` when the daemon has
   * adjusted a lever in-process (e.g. steward autotune raising the implement
   * cap on a sustained backlog). Returns null when the daemon is unreachable.
   *
   * When defined, `lever show` calls this and overlays the result on
   * `readCurrent()`, displaying both the configured and effective values if
   * they differ, or marking the value as persisted-only when the daemon is
   * down. The reflection binding path receives the effective value (or an
   * explicit "unknown" marker) rather than the potentially stale persisted one.
   */
  readEffective?: (querier: CapQuerier) => Promise<EffectiveRead | null>
  allowedValues: AllowedValues
  /**
   * The exact `mars` command that applies a change, with `<placeholder>` for
   * variable parts. null when no `mars` command exists — these are the gaps
   * the follow-up slice will address.
   */
  gesture: string | null
  /** Whether the change takes effect without `mars daemon reload` or restart. */
  appliesWithoutRestart: boolean
  /**
   * The verified production consumer of this lever — the file and symbol that
   * reads the lever's config value to alter runtime behaviour.
   *
   * When present, wiring state is `wired` (or `no-gesture` if `gesture` is
   * null). When absent, wiring state is `no-consumer` — meaning nothing in
   * production acts on this lever's value. The build-enforcing test verifies
   * every declared reference actually exists; a phantom consumer ref fails the
   * build immediately.
   */
  consumer?: LeverConsumerRef
  /**
   * Present only for verify-family recipe levers. Used by
   * `formatRecipeCatalog` to build reflector prompts.
   */
  recipe?: RecipeMetadata
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const REGISTRY: LeverRegistryEntry[] = [
  // ── model ─────────────────────────────────────────────────────────────────
  {
    id: 'worker.model',
    label: 'Worker default model',
    family: 'model',
    scope: 'global',
    readCurrent: () => '(see mars worker list)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars worker add <name> --model <model>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/daemon/server.ts', symbol: 'startDaemon' },
  },
  {
    id: 'worker.effort',
    label: 'Worker default effort tier',
    family: 'model',
    scope: 'global',
    readCurrent: () => '(see mars worker list)',
    allowedValues: { type: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    gesture: 'mars worker add <name> --effort <effort>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/daemon/server.ts', symbol: 'startDaemon' },
  },

  // ── provider ──────────────────────────────────────────────────────────────
  {
    id: 'provider.default',
    label: 'Default agent provider',
    family: 'provider',
    scope: 'global',
    readCurrent: () => {
      try {
        return loadDaemonConfig().defaultProvider
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['claude', 'codex', 'gemini'] },
    gesture: 'mars lever set provider.default <claude|codex|gemini>',
    appliesWithoutRestart: false,
    consumer: { file: 'src/core/daemon/server.ts', symbol: 'startDaemon' },
  },

  // ── workflow ──────────────────────────────────────────────────────────────
  {
    id: 'workflow.selection',
    label: 'Per-task workflow selection',
    family: 'workflow',
    scope: 'per-task',
    readCurrent: () => '(per-task, set at task creation)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars task add --workflow <name>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/cli/commands/task.ts', symbol: 'taskAdd' },
  },
  {
    id: 'workflow.steps',
    label: 'Workflow step definitions (user-owned .mars/workflows/*.js files)',
    family: 'workflow',
    scope: 'per-workflow',
    // Workflow definitions live in `.mars/workflows/<name>.js` — user-owned files
    // that the operator can author and edit. The sentinel here reflects that there
    // is no single "current value" persisted in daemon.json; the consumer slice
    // "Fix workflow.steps lever readCurrent and metadata" will improve this to
    // enumerate the actual workflow files on disk.
    readCurrent: () => '(see .mars/workflows/*.js — user-owned, editable)',
    allowedValues: { type: 'freeform' },
    // Workflow step definitions live in .mars/workflows/<name>.js. The
    // `mars workflow author <name> --from <-|path>` command creates or revises
    // a workflow definition as an agent-authored draft (body via stdin or file),
    // which must then be approved with `mars workflow approve <name>` before it
    // becomes dispatch-eligible.
    gesture: 'mars workflow author <name> --from <-|path>',
    appliesWithoutRestart: true,
    // The real consumer of workflow step definitions is the workflow loader —
    // `loadWorkflowByName` reads the user-owned JS file and executes its steps.
    consumer: {
      file: 'src/workflows/queue-workflow-store.ts',
      symbol: 'loadWorkflowByName',
    },
  },

  // ── verify (recipes folded in from improvement-recipes.ts) ────────────────
  {
    id: 'verify.add-typecheck',
    label: 'Add TypeScript typecheck verify gate',
    family: 'verify',
    scope: 'global',
    readCurrent: () => '(see mars verify-gate list)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars verify add typecheck --cmd npx -- tsc --noEmit',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/reflector.ts', symbol: 'buildPrompt' },
    recipe: {
      triggerPattern: 'Repo has TypeScript files but no typecheck gate',
      problem:
        'Your repo has TypeScript files but no typecheck gate. Add one to catch type errors before merge.',
      solution: 'Run `tsc --noEmit` as a verify gate so type errors block task merges.',
      setupSteps: [
        'Ensure a tsconfig.json exists at the repo root',
        'Add gate: mars verify add typecheck --cmd npx --args "tsc --noEmit"',
      ],
      verifyGate: { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'] },
      maturityLevel: 'typecheck',
    },
  },
  {
    id: 'verify.add-unit-tests',
    label: 'Add unit test verify gate',
    family: 'verify',
    scope: 'global',
    readCurrent: () => '(see mars verify-gate list)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars verify add test --cmd npm -- test',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/reflector.ts', symbol: 'buildPrompt' },
    recipe: {
      triggerPattern: 'Repo has test files but no test gate',
      problem: 'Your repo has test files but no test gate. Add one to run tests on every task.',
      solution: 'Run `npm test` as a verify gate so test failures block task merges.',
      setupSteps: [
        'Confirm `npm test` exits non-zero on failure',
        'Add gate: mars verify add test --cmd npm --args "test"',
      ],
      verifyGate: { name: 'test', cmd: 'npm', args: ['test'] },
      maturityLevel: 'tests',
    },
  },
  {
    id: 'verify.add-lint',
    label: 'Add lint verify gate',
    family: 'verify',
    scope: 'global',
    readCurrent: () => '(see mars verify-gate list)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars verify add lint --cmd npx -- eslint .',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/reflector.ts', symbol: 'buildPrompt' },
    recipe: {
      triggerPattern: 'Repo has a linter config but no lint gate',
      problem: 'Your repo has a linter config but no lint gate.',
      solution: 'Run `eslint .` as a verify gate so lint errors block task merges.',
      setupSteps: [
        'Confirm ESLint is installed (`npx eslint --version`)',
        'Add gate: mars verify add lint --cmd npx --args "eslint ."',
      ],
      verifyGate: { name: 'lint', cmd: 'npx', args: ['eslint', '.'] },
      maturityLevel: 'tests',
    },
  },
  {
    id: 'verify.add-e2e',
    label: 'Add Playwright E2E verify gate',
    family: 'verify',
    scope: 'global',
    readCurrent: () => '(see mars verify-gate list)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars verify add e2e --cmd npx -- playwright test',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/reflector.ts', symbol: 'buildPrompt' },
    recipe: {
      triggerPattern: 'UI changes ship without automated browser verification',
      problem: 'UI changes ship without automated browser verification. Add Playwright E2E.',
      solution:
        'Run Playwright tests as a verify gate so visual regressions block task merges.',
      setupSteps: [
        'Install @playwright/test',
        'Create e2e/ with smoke test',
        'Configure a live dev server in the workflow environment',
        'Set up credentials: mars credentials set SSO_TOKEN MARS_SSO_TOKEN',
        'Add gate: mars verify add e2e --cmd npx --args "playwright test"',
      ],
      verifyGate: { name: 'e2e', cmd: 'npx', args: ['playwright', 'test'] },
      maturityLevel: 'e2e',
    },
  },
  {
    id: 'verify.add-integration-tests',
    label: 'Add integration test verify gate',
    family: 'verify',
    scope: 'global',
    readCurrent: () => '(see mars verify-gate list)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars verify add integration --cmd npm -- run test:integration',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/reflector.ts', symbol: 'buildPrompt' },
    recipe: {
      triggerPattern: 'Repo has integration tests but no gate for them',
      problem: 'Your repo has integration tests but no gate for them.',
      solution:
        'Run integration tests as a verify gate so integration failures block task merges.',
      setupSteps: [
        'Confirm your integration test command exits non-zero on failure',
        'Add gate: mars verify add integration --cmd npm --args "run test:integration"',
      ],
      maturityLevel: 'tests',
    },
  },
  {
    id: 'verify.add-sso-credentials',
    label: 'Add SSO credential injection for E2E tests',
    family: 'verify',
    scope: 'global',
    readCurrent: () => '(see mars credentials list)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars credentials set SSO_TOKEN MARS_SSO_TOKEN',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/reflector.ts', symbol: 'buildPrompt' },
    recipe: {
      triggerPattern: 'E2E tests need authenticated flows',
      problem: 'E2E tests need authenticated flows. Set up SSO credential injection.',
      solution:
        'Use `mars credentials set` to register the env-var name that holds the SSO token. The secret itself lives in your shell environment, not in Mars.',
      setupSteps: [
        'Identify the env var your app reads for the SSO token (e.g. MARS_SSO_TOKEN)',
        'Register the credential name→env-var mapping: mars credentials set SSO_TOKEN MARS_SSO_TOKEN',
        'Export the actual secret in your shell or CI environment: export MARS_SSO_TOKEN=<your-token>',
        'Create an auth state file (e.g. e2e/auth.json) that Playwright loads via `storageState`',
        'Add a global setup script that reads the credential and writes auth state before tests run',
        'Reference auth state in playwright.config.ts: `use: { storageState: "e2e/auth.json" }`',
      ],
      maturityLevel: 'e2e',
    },
  },

  // ── concurrency ───────────────────────────────────────────────────────────
  // Note: contrary to the original lever table which listed caps as "**none**",
  // `mars daemon set-cap` exists and covers all five caps. Gestures are present.
  {
    id: 'caps.implement',
    label: 'Maximum concurrent implement slots',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().caps.implement)
      } catch {
        return null
      }
    },
    consumer: { file: 'src/core/daemon/server.ts', symbol: 'startDaemon' },
    readEffective: async (querier) => {
      try {
        const status = await querier.sendRequest({ op: 'status' }) as {
          implementCap: { configured: number; effective: number; reason: string | null }
        }
        if (
          typeof status !== 'object' ||
          status === null ||
          !('implementCap' in status)
        ) {
          return null
        }
        const { implementCap } = status
        return {
          effective: String(implementCap.effective),
          reason: implementCap.reason,
        }
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars daemon set-cap implement <n>',
    appliesWithoutRestart: true,
  },
  {
    id: 'caps.triage',
    label: 'Maximum concurrent triage slots',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().caps.triage)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars daemon set-cap triage <n>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/daemon/server.ts', symbol: 'startDaemon' },
  },
  {
    id: 'caps.refine',
    label: 'Maximum concurrent refine slots',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().caps.refine)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars daemon set-cap refine <n>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/daemon/server.ts', symbol: 'startDaemon' },
  },
  {
    id: 'caps.setup-install',
    label: 'Maximum concurrent worktree dependency installs',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().caps.setupInstall)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars daemon set-cap setup-install <n>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/daemon/server.ts', symbol: 'startDaemon' },
  },
  {
    id: 'caps.verify',
    label: 'Maximum concurrent verify steps',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().caps.verify)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars daemon set-cap verify <n>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/daemon/server.ts', symbol: 'startDaemon' },
  },

  // ── steward autotune ──────────────────────────────────────────────────────
  {
    id: 'steward.autotune',
    label: 'Steward implement-cap autotuner (on/off)',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => {
      try {
        const level = readLeverAutonomyLevel(STEWARD_RUNTIME_TUNE_LEVER)
        return level === 'off' ? 'off' : 'on'
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['on', 'off'] },
    /**
     * Gesture: `mars lever set steward.autotune off` disables the autotuner;
     * `mars lever set steward.autotune on` re-enables it. Takes effect on the
     * next backlog-degraded or paging-sample event without a daemon restart.
     */
    gesture: 'mars lever set steward.autotune <on|off>',
    appliesWithoutRestart: true,
  },
  {
    id: 'steward.autotune-max-implement',
    label: 'Steward autotune implement-cap ceiling (hard upper bound)',
    family: 'concurrency',
    scope: 'global',
    readCurrent: () => {
      try {
        const n = readAutotuneMaxImplement()
        return n !== null ? String(n) : '(not set — defaults to 2× configured cap)'
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    /**
     * Gesture: `mars lever set steward.autotune-max-implement 8` bounds the
     * autotuner at 8 slots regardless of the configured cap. Use `clear` to
     * remove the ceiling and restore the default 2× behaviour. Takes effect
     * immediately (no restart required).
     */
    gesture: 'mars lever set steward.autotune-max-implement <n>',
    appliesWithoutRestart: true,
  },

  // ── operator ──────────────────────────────────────────────────────────────
  {
    id: 'operator.recovery',
    label: 'Recovery lever (enables/disables fix-task spawning)',
    family: 'operator',
    scope: 'global',
    readCurrent: () => {
      try {
        return readControlLevers().recovery
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['on', 'off'] },
    gesture: 'mars operator set recovery <on|off>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/config/levers.ts', symbol: 'resolveControlLevers' },
  },
  {
    id: 'operator.dispatch',
    label: 'Dispatch lever (pauses/resumes task dispatch)',
    family: 'operator',
    scope: 'global',
    readCurrent: () => {
      try {
        // Reads from daemon.json (persisted state). A live 'storm' or 'quota'
        // pause exists only in the running daemon process; use `mars operator
        // status` or `mars daemon status` for the full live state.
        return readPersistedPaused() ? 'off' : 'on'
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['on', 'off'] },
    gesture: 'mars operator set dispatch <on|off>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/daemon/pause-state.ts', symbol: 'createPauseController' },
  },
  {
    id: 'operator.scoring',
    label: 'Scoring lever (enables/disables task scoring)',
    family: 'operator',
    scope: 'global',
    readCurrent: () => {
      try {
        return readControlLevers().scoring
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['on', 'off'] },
    gesture: 'mars operator set scoring <on|off>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/config/levers.ts', symbol: 'resolveControlLevers' },
  },
  {
    id: 'operator.memory-capture',
    label: 'Memory-capture lever (enables/disables inserting memory packets after reflection suggestions are persisted)',
    family: 'operator',
    scope: 'global',
    readCurrent: () => {
      try {
        return readControlLevers().memoryCapture
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['on', 'off'] },
    gesture: 'mars operator set memory-capture <on|off>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/config/levers.ts', symbol: 'resolveControlLevers' },
  },
  {
    id: 'operator.auto-run-reflect',
    label: 'Auto-run-reflect lever (runs reflection automatically when conditions are met, vs. waiting for operator action)',
    family: 'operator',
    scope: 'global',
    readCurrent: () => {
      try {
        return readControlLevers().autoRunReflect
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['on', 'off'] },
    gesture: 'mars operator set auto-run-reflect <on|off>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/config/levers.ts', symbol: 'resolveControlLevers' },
  },

  // ── budget ────────────────────────────────────────────────────────────────
  {
    id: 'budget.window',
    label: 'Budget window duration',
    family: 'budget',
    scope: 'global',
    readCurrent: () => {
      try {
        const config = readBudgetConfig()
        if (!config || config.windowMs === null) return '(not set)'
        return `${config.windowMs}ms`
      } catch {
        return null
      }
    },
    allowedValues: { type: 'freeform' },
    gesture: 'mars operator set budget-window <duration>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/spend-meter.ts', symbol: 'computeBudgetStatus' },
  },
  {
    id: 'budget.window-tokens',
    label: 'Budget window token ceiling',
    family: 'budget',
    scope: 'global',
    readCurrent: () => {
      try {
        const config = readBudgetConfig()
        if (!config || config.windowTokens === null) return '(not set)'
        return String(config.windowTokens)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars operator set budget-window-tokens <n>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/spend-meter.ts', symbol: 'computeBudgetStatus' },
  },
  {
    id: 'budget.arc-tokens',
    label: 'Budget per-arc token ceiling',
    family: 'budget',
    scope: 'global',
    readCurrent: () => {
      try {
        const config = readBudgetConfig()
        if (!config || config.arcTokens === null) return '(not set)'
        return String(config.arcTokens)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars operator set budget-arc-tokens <n>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/spend-meter.ts', symbol: 'computeBudgetStatus' },
  },

  // ── scoring ───────────────────────────────────────────────────────────────
  {
    id: 'scoring.auto-trigger',
    label: 'Scoring auto-trigger (raises proposal on sustained low score trend)',
    family: 'scoring',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().scoring.autoTrigger)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['true', 'false'] },
    gesture: 'mars lever set scoring.auto-trigger <true|false>',
    appliesWithoutRestart: false,
    consumer: { file: 'src/core/lib/scorer-trend-trigger.ts', symbol: 'runScorerLowTrendTrigger' },
  },
  {
    id: 'scoring.low-trend-threshold',
    label: 'Scoring low-trend score threshold (0–1)',
    family: 'scoring',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().scoring.lowTrendThreshold)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 0, max: 1 },
    gesture: 'mars lever set scoring.low-trend-threshold <0–1>',
    appliesWithoutRestart: false,
    consumer: { file: 'src/core/lib/scorer-trend-trigger.ts', symbol: 'runScorerLowTrendTrigger' },
  },
  {
    id: 'scoring.low-trend-window',
    label: 'Scoring low-trend rolling window (number of instances)',
    family: 'scoring',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().scoring.lowTrendWindow)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 1 },
    gesture: 'mars lever set scoring.low-trend-window <n>',
    appliesWithoutRestart: false,
    consumer: { file: 'src/core/lib/scorer-trend-trigger.ts', symbol: 'runScorerLowTrendTrigger' },
  },
  {
    id: 'scorer.acceptance',
    label: 'Scorer acceptance (which scorers are active)',
    family: 'scoring',
    scope: 'global',
    readCurrent: () => '(see mars scorer list)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars scorer accept <id>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/core/lib/scorer-runtime.ts', symbol: 'runScorersForTask' },
  },

  // ── self-evolve ───────────────────────────────────────────────────────────
  {
    id: 'self-evolve.drift-threshold-pct',
    label: 'Self-evolve drift threshold percentage',
    family: 'self-evolve',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().selfEvolve.driftThresholdPct)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 0 },
    gesture: 'mars lever set self-evolve.drift-threshold-pct <n>',
    appliesWithoutRestart: false,
    // No consumer declared: this value is stored in daemon.json and read by
    // the config loader, but no production subsystem binds a runtime decision
    // to it yet. mars-e78e0004 decides whether to wire it or cut it.
    // NOTE: self-evolve-trigger.ts does reference driftThresholdPct; the brief
    // author classified this as no-consumer, so we follow suit until
    // mars-e78e0004 resolves the wiring decision.
  },
  {
    id: 'self-evolve.auto-enqueue',
    label: 'Auto-enqueue lever (enables/disables automatic enqueueing of accepted reflection suggestions as tasks)',
    family: 'self-evolve',
    scope: 'global',
    readCurrent: () => {
      // `selfEvolve.autoEnqueue` is stored in daemon.json but stripped by the
      // Zod schema in loadDaemonConfig(). The consumer slice "Add code-step
      // levers to registry, config, and apply" extends the schema to expose
      // this field; until then, return a sentinel rather than a stale default.
      try {
        const file = loadDaemonConfig()
        // Access via the raw selfEvolve cast — the Zod schema strips unknown
        // fields, so we access this as an opaque record until the schema is
        // extended by the consumer slice.
        const se = file.selfEvolve as unknown as Record<string, unknown>
        const val = se.autoEnqueue
        if (typeof val === 'boolean') return String(val)
        return '(not set — defaults to false)'
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['true', 'false'] },
    gesture: 'mars lever set self-evolve.auto-enqueue <true|false>',
    appliesWithoutRestart: true,
    // No consumer yet: the consumer slice "Add code-step levers to registry,
    // config, and apply" wires autoEnqueue to the reflector's save path.
  },
  {
    id: 'self-evolve.task-confidence-threshold',
    label: 'Minimum confidence threshold (0–1) for persisting reflection suggestions as proposals',
    family: 'self-evolve',
    scope: 'global',
    readCurrent: () => {
      // `selfEvolve.taskConfidenceThreshold` is stored in daemon.json but
      // stripped by the Zod schema in loadDaemonConfig(). The consumer slice
      // extends the schema; until then return a sentinel.
      try {
        const file = loadDaemonConfig()
        const se = file.selfEvolve as unknown as Record<string, unknown>
        const val = se.taskConfidenceThreshold
        if (typeof val === 'number') return String(val)
        return '(not set — defaults to 0)'
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 0, max: 1 },
    gesture: 'mars lever set self-evolve.task-confidence-threshold <0-1>',
    appliesWithoutRestart: true,
    // `persistSuggestions` in reflector.ts reads this threshold to decide
    // whether a suggestion clears the confidence bar for proposal creation.
    consumer: { file: 'src/core/lib/reflector.ts', symbol: 'persistSuggestions' },
  },
  // ── task-spec ─────────────────────────────────────────────────────────────
  {
    id: 'task-spec.files',
    label: 'Task file hints (guides the coder to relevant paths)',
    family: 'task-spec',
    scope: 'per-task',
    readCurrent: () => '(per-task, set at task creation)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars task add --files <path>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/cli/commands/task.ts', symbol: 'taskAdd' },
  },
  {
    id: 'task-spec.verify',
    label: 'Task verify override (custom verify command for this task)',
    family: 'task-spec',
    scope: 'per-task',
    readCurrent: () => '(per-task, set at task creation)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars task add --verify "<cmd>"',
    appliesWithoutRestart: true,
    consumer: { file: 'src/cli/commands/task.ts', symbol: 'taskAdd' },
  },
  {
    id: 'task-spec.done',
    label: 'Task done criteria',
    family: 'task-spec',
    scope: 'per-task',
    readCurrent: () => '(per-task, set at task creation)',
    allowedValues: { type: 'freeform' },
    gesture: 'mars task add --done "<criterion>"',
    appliesWithoutRestart: true,
    consumer: { file: 'src/cli/commands/task.ts', symbol: 'taskAdd' },
  },
  {
    id: 'task-spec.merge',
    label: 'Task merge mode',
    family: 'task-spec',
    scope: 'per-task',
    readCurrent: () => '(per-task, set at task creation)',
    allowedValues: { type: 'enum', values: ['auto', 'gated'] },
    gesture: 'mars task add --merge auto|gated',
    appliesWithoutRestart: true,
    consumer: { file: 'src/cli/commands/task.ts', symbol: 'taskAdd' },
  },
  {
    id: 'task-spec.priority',
    label: 'Task priority (0 = lowest, 3 = highest)',
    family: 'task-spec',
    scope: 'per-task',
    readCurrent: () => '(per-task, set at task creation)',
    allowedValues: { type: 'range', min: 0, max: 3 },
    gesture: 'mars task add --priority <0-3>',
    appliesWithoutRestart: true,
    consumer: { file: 'src/cli/commands/task.ts', symbol: 'taskAdd' },
  },
  {
    id: 'task-spec.tag',
    label: 'Task worker tag (routes to specific worker type)',
    family: 'task-spec',
    scope: 'per-task',
    readCurrent: () => '(per-task, set at task creation)',
    allowedValues: { type: 'enum', values: ['coder', 'writer'] },
    gesture: 'mars task add --tag coder|writer',
    appliesWithoutRestart: true,
    consumer: { file: 'src/cli/commands/task.ts', symbol: 'taskAdd' },
  },
]

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns all lever registry entries that carry a `verifyGate` spec, paired
 * with their lever id.
 *
 * This is the only accessor `propose-gates-from-levers.ts` needs — it avoids
 * reaching into the internal REGISTRY array directly and keeps the coupling
 * to the data structure inside this module.
 */
export function getLeversWithVerifyGate(): Array<{ leverId: string; recipe: RecipeMetadata }> {
  return REGISTRY
    .filter(
      (e): e is LeverRegistryEntry & { recipe: RecipeMetadata } =>
        e.recipe !== undefined && e.recipe.verifyGate !== undefined,
    )
    .map((e) => ({ leverId: e.id, recipe: e.recipe }))
}

/**
 * Returns the full lever registry. Returns a shallow copy so callers cannot
 * mutate the internal catalog.
 */
export function loadLeverRegistry(): LeverRegistryEntry[] {
  return [...REGISTRY]
}

/**
 * Returns registry entries that have no gesture — the documented gaps that
 * a follow-up slice will address with new `mars` commands.
 */
export function noGestureEntries(): LeverRegistryEntry[] {
  return REGISTRY.filter((e) => e.gesture === null)
}

/**
 * Returns registry entries that have no declared consumer — levers whose
 * config value is stored but not yet acted on by any production subsystem.
 *
 * An entry without a `consumer` field is `no-consumer`: changing its value
 * has no runtime effect until the feature is wired. The count of these entries
 * is reported separately from gesture-gaps in the `mars lever list` footer.
 */
export function noConsumerEntries(): LeverRegistryEntry[] {
  return REGISTRY.filter((e) => !e.consumer)
}

/**
 * Derives the wiring state of a lever entry from its declared consumer and
 * gesture.
 *
 * - `wired`       — consumer declared and gesture present.
 * - `no-gesture`  — consumer declared but no CLI verb to set it.
 * - `no-consumer` — no production code declared as reading this lever's value.
 */
export function getWiringState(e: LeverRegistryEntry): LeverWiringState {
  if (!e.consumer) return 'no-consumer'
  if (!e.gesture) return 'no-gesture'
  return 'wired'
}

/**
 * Renders every lever in the registry as a compact list suitable for
 * inclusion in reflector prompts.
 *
 * Each line describes one lever: its id, label, family, live current value
 * (via `readCurrent()`, or "(unknown)" on error), allowed values, and the
 * `mars` command that applies a change (or "(no command — gap)" when none
 * exists).
 *
 * Accepts the full registry (from `loadLeverRegistry()`) or any subset.
 */
export function formatLeverList(entries: LeverRegistryEntry[]): string {
  if (entries.length === 0) return '_(no levers in registry)_\n'
  const rows = entries.map((e) => {
    const current = e.readCurrent()
    const allowed =
      e.allowedValues.type === 'enum'
        ? `enum(${e.allowedValues.values.join('|')})`
        : e.allowedValues.type === 'range'
          ? `range(${e.allowedValues.min}..${e.allowedValues.max ?? '∞'})`
          : 'freeform'
    const gesture = e.gesture ?? '(no command — gap)'
    return `- **${e.id}** | ${e.label} | family: ${e.family} | current: ${current ?? '(unknown)'} | allowed: ${allowed} | gesture: \`${gesture}\``
  })
  return rows.join('\n') + '\n'
}

/**
 * Renders verify-family recipe entries as Markdown for inclusion in reflector
 * prompts. Replaces the former `formatRecipeCatalog` from improvement-recipes.ts.
 *
 * Accepts the full registry (from `loadLeverRegistry()`) or any subset; only
 * entries that carry a `recipe` field are rendered.
 */
export function formatRecipeCatalog(entries: LeverRegistryEntry[]): string {
  const withRecipes = entries.filter((e) => e.recipe !== undefined)
  if (withRecipes.length === 0) {
    return '_(no improvement recipes)_\n'
  }

  const sections = withRecipes.map((e) => {
    const r = e.recipe!
    const lines: string[] = [
      `### ${e.label} (\`${e.id}\`)`,
      '',
      `**Trigger:** ${r.triggerPattern}`,
      '',
      `**Problem:** ${r.problem}`,
      '',
      `**Solution:** ${r.solution}`,
      '',
      `**Maturity level:** ${r.maturityLevel}`,
    ]

    if (r.setupSteps.length > 0) {
      lines.push('', '**Setup steps:**')
      for (const step of r.setupSteps) {
        lines.push(`- ${step}`)
      }
    }

    if (r.verifyGate) {
      const { name, cmd, args, scope } = r.verifyGate
      const cmdStr = [cmd, ...args].join(' ')
      const scopePart = scope ? ` (scope: ${scope})` : ''
      lines.push('', `**Verify gate:** \`${name}\` → \`${cmdStr}\`${scopePart}`)
    }

    return lines.join('\n')
  })

  return sections.join('\n\n') + '\n'
}
