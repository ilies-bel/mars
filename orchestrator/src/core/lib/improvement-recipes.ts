/**
 * Catalog of known harness improvement recipes.
 *
 * Each recipe describes a problem the user's repo might have, what to do
 * about it, and — optionally — a verify gate that gets wired in once the
 * recipe is applied.
 */

export interface ImprovementRecipe {
  id: string
  name: string
  /** When to suggest this recipe (human-readable trigger description). */
  triggerPattern: string
  problem: string
  solution: string
  setupSteps: string[]
  verifyGate?: { name: string; cmd: string; args: string[]; scope?: string }
  maturityLevel: 'bare' | 'typecheck' | 'tests' | 'e2e'
}

const RECIPES: ImprovementRecipe[] = [
  {
    id: 'add-typecheck',
    name: 'Add TypeScript typecheck gate',
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
  {
    id: 'add-unit-tests',
    name: 'Add unit test gate',
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
  {
    id: 'add-lint',
    name: 'Add lint gate',
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
  {
    id: 'add-e2e',
    name: 'Add Playwright E2E gate',
    triggerPattern: 'UI changes ship without automated browser verification',
    problem: 'UI changes ship without automated browser verification. Add Playwright E2E.',
    solution: 'Run Playwright tests as a verify gate so visual regressions block task merges.',
    setupSteps: [
      'Install @playwright/test',
      'Create e2e/ with smoke test',
      'Configure previewCmd',
      'Set up credentials: mars credentials set SSO_TOKEN SSO_TOKEN_ENV',
      'Add gate: mars verify add e2e --cmd npx --args "playwright test"',
    ],
    verifyGate: { name: 'e2e', cmd: 'npx', args: ['playwright', 'test'] },
    maturityLevel: 'e2e',
  },
  {
    id: 'add-integration-tests',
    name: 'Add integration test gate',
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
  {
    id: 'add-sso-credentials',
    name: 'Add SSO credential injection for E2E tests',
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
]

/**
 * Returns the full catalog of built-in improvement recipes.
 *
 * Returns a shallow copy so callers cannot mutate the internal catalog.
 */
export function loadImprovementRecipes(): ImprovementRecipe[] {
  return [...RECIPES]
}

/**
 * Renders a recipe catalog as Markdown for inclusion in reflector prompts.
 *
 * Each recipe becomes a level-3 heading with its key fields listed below.
 * The `verifyGate` command is rendered inline when present.
 */
export function formatRecipeCatalog(recipes: ImprovementRecipe[]): string {
  if (recipes.length === 0) {
    return '_(no improvement recipes)_\n'
  }

  const sections = recipes.map((r) => {
    const lines: string[] = [
      `### ${r.name} (\`${r.id}\`)`,
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
