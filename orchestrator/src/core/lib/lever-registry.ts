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
 */

import { loadDaemonConfig, readControlLevers, readPersistedPaused } from '../daemon/config'
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

export type LeverScope = 'global' | 'per-workflow' | 'per-task'

export interface AllowedEnum {
  type: 'enum'
  values: readonly string[]
}
export interface AllowedRange {
  type: 'range'
  min: number
  max?: number
}
export interface AllowedFreeform {
  type: 'freeform'
}
export type AllowedValues = AllowedEnum | AllowedRange | AllowedFreeform

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

export interface LeverRegistryEntry {
  id: string
  label: string
  family: LeverFamily
  scope: LeverScope
  /**
   * Returns the live value as a human-readable string.
   * Returns null when the value cannot be determined without a daemon or DB
   * connection (e.g. active verify gates, worker registry).
   */
  readCurrent(): string | null
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
  },
  {
    id: 'workflow.steps',
    label: 'Workflow step definitions',
    family: 'workflow',
    scope: 'per-workflow',
    readCurrent: () => '(see .mars/workflows/*.js)',
    allowedValues: { type: 'freeform' },
    // Workflow step definitions live in .mars/workflows/<name>.js. The
    // `mars workflow author <name>` command creates or revises a workflow
    // definition as an agent-authored draft, which must then be approved with
    // `mars workflow approve <name>` before it becomes dispatch-eligible.
    gesture: 'mars workflow author <name>',
    appliesWithoutRestart: true,
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
    recipe: {
      triggerPattern: 'UI changes ship without automated browser verification',
      problem: 'UI changes ship without automated browser verification. Add Playwright E2E.',
      solution:
        'Run Playwright tests as a verify gate so visual regressions block task merges.',
      setupSteps: [
        'Install @playwright/test',
        'Create e2e/ with smoke test',
        'Configure a live dev server in the workflow environment',
        'Set up credentials: mars credentials set SSO_TOKEN SSO_TOKEN_ENV',
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
    gesture: 'mars credentials set SSO_TOKEN <your-token>',
    appliesWithoutRestart: true,
    recipe: {
      triggerPattern: 'E2E tests need authenticated flows',
      problem: 'E2E tests need authenticated flows. Set up SSO credential injection.',
      solution:
        'Use `mars credentials set` to store SSO tokens and inject them into E2E test runs.',
      setupSteps: [
        'Identify the env var your app reads for the SSO token (e.g. SSO_TOKEN)',
        'Store it: mars credentials set SSO_TOKEN <your-token>',
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
  },

  // ── self-evolve ───────────────────────────────────────────────────────────
  {
    id: 'self-evolve.auto-enqueue',
    label: 'Self-evolve auto-enqueue (auto-enqueues high-confidence mechanical reflection suggestions as tasks)',
    family: 'self-evolve',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().selfEvolve.autoEnqueue)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'enum', values: ['true', 'false'] },
    gesture: 'mars lever set self-evolve.auto-trigger <true|false>',
    appliesWithoutRestart: false,
  },
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
  },
  {
    id: 'self-evolve.task-confidence-threshold',
    label: 'Self-evolve minimum task-confidence for auto-enqueue (0–1)',
    family: 'self-evolve',
    scope: 'global',
    readCurrent: () => {
      try {
        return String(loadDaemonConfig().selfEvolve.taskConfidenceThreshold)
      } catch {
        return null
      }
    },
    allowedValues: { type: 'range', min: 0, max: 1 },
    gesture: 'mars lever set self-evolve.task-confidence-threshold <0–1>',
    appliesWithoutRestart: false,
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
  },
]

// ─── Public API ───────────────────────────────────────────────────────────────

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
