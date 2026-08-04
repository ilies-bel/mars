import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { defineWorkflow, runWorkflow, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'
import { createQueueWorkflowStore } from './queue-workflow-store'
import { resolveContext } from '../core/context'
import { initDatabases } from '../init/databases'
import { WIZARD_DEFAULTS, type WizardChoices } from '../init/wizard'
import { VerifyGateInputSchema } from '../core/verify-gates'
import { installOnboardingVerifyGates } from '../init/seed-verify-gates'
import {
  applyGitignoreScaffold,
  mergeMcpJson,
  planClaudeConflicts,
  scaffoldClaudeConfig,
} from '../init/scaffold'
import { planWorkflowCopies, scaffoldWorkflows } from '../init/scaffold-workflows'
import { writeSlimInit } from '../init/writer'
import { readInitManifest, writeInitManifest } from '../init/init-manifest'
import { writeRecipesSeed } from '../init/recipes-seed'
import { activatePlugin, realDeps, type ClaudePluginDeps } from '../commands/claude-plugin.js'
import { ensureProjectRegistered } from '../registry/projects.js'

// Mirrors WizardChoices exactly so a resolved WizardChoices feeds the
// workflow input without a structural-type mismatch.
const wizardChoicesSchema = z.object({
  registerProject: z.boolean(),
  verifyGates: z.array(VerifyGateInputSchema),
})

const initInputSchema = z.object({
  wizardChoices: wizardChoicesSchema.optional(),
})

type InitInput = z.infer<typeof initInputSchema>

interface InitWorkflowOutput {
  written: string[]
}

/**
 * Copy the framework's bundled Claude Code config (`.claude/**` + root
 * `CLAUDE.md`) into the target repo. `runInit` pre-flights conflicts so by
 * the time this step runs, the user has either accepted overwrite via
 * `--force` or there is nothing to overwrite — we therefore call
 * `scaffoldClaudeConfig` with `force: true` and treat any residual conflict
 * (e.g. a file that appeared between pre-flight and now) as a hard error.
 */
const runScaffoldClaude = async (written: string[]): Promise<string[]> => {
  const ctx = resolveContext()
  const result = scaffoldClaudeConfig({ repoRoot: ctx.repoRoot, force: true })
  if (result.status === 'conflict') {
    throw new Error(
      `scaffold-claude: unexpected conflict after pre-flight: ${result.conflicts.join(', ')}`,
    )
  }
  return [...written, ...result.written]
}

/**
 * Scaffold the user-owned workflow templates into `.mars/workflows/*.js`
 * (ADR-0056) and record the written paths in the init manifest (ADR-0057's
 * ownership ledger). Runs AFTER scaffold-claude and BEFORE init-databases.
 *
 * `mars init` never clobbers a pre-existing workflow file: `scaffoldWorkflows`
 * runs with `force: false`, so on a fresh repo every template lands, and on a
 * repo whose workflows the consumer has edited nothing is overwritten. Only the
 * files actually written this run are appended to the manifest; previously
 * scaffolded (and possibly hand-edited) workflows already in the manifest are
 * preserved so `mars update` can still recognise them as owned.
 */
const runScaffoldWorkflows = async (written: string[]): Promise<string[]> => {
  const ctx = resolveContext()
  const result = scaffoldWorkflows({ repoRoot: ctx.repoRoot, force: false })
  // `scaffoldWorkflows` with force:false never reports a conflict (user-owned
  // files are silently skipped, not treated as errors); narrow defensively.
  const justWritten = result.status === 'ok' ? result.written : []

  // Owned-workflow ledger: union the manifest with every workflow path we know
  // about this run — the ones just written plus any already on disk that match
  // a bundled template (so a re-init does not drop an existing entry just
  // because the file was skipped as pre-existing).
  const onDiskOwned = planWorkflowCopies(ctx.repoRoot)
    .filter((c) => existsSync(c.dest))
    .map((c) => c.rel)
  const manifestAdds = Array.from(new Set([...justWritten, ...onDiskOwned]))
  if (manifestAdds.length > 0) {
    const existing = readInitManifest(ctx.stateDir)
    const existingSet = new Set(existing)
    const toAdd = manifestAdds.filter((p) => !existingSet.has(p))
    if (toAdd.length > 0) {
      writeInitManifest(ctx.stateDir, [...existing, ...toAdd])
    }
  }

  return [...written, ...justWritten]
}

/**
 * Materialise the canonical Mars schema (tasks, proposals, actionQueue, …) in
 * the per-repo database and fold in any legacy `.mars/mars.db` SQLite file.
 * Idempotent (`ensureSchema` is IF-NOT-EXISTS DDL; the importer no-ops after
 * its first successful run).
 *
 * Under the embedded backend the database only exists while the daemon runs
 * (it provisions the PostgreSQL server and publishes `.mars/pg.dsn`). When the
 * DSN is not published yet — the common `mars init` case on a fresh repo —
 * skip with a note instead of failing: the daemon applies the same schema and
 * import on its next start.
 */
const runInitDatabases = async (written: string[]): Promise<string[]> => {
  const ctx = resolveContext()
  const reachable =
    process.env.MARS_DB_BACKEND === 'pglite' ||
    existsSync(resolve(ctx.stateDir, 'pg.dsn'))
  if (reachable) {
    await initDatabases()
  } else {
    process.stdout.write(
      '[mars init] database not provisioned yet (daemon not running) — schema will be applied on first daemon start\n',
    )
  }

  // Merge any root-level CLAUDE.md (written by scaffold) into the init
  // manifest so it is listed alongside the per-folder CLAUDE.md files that
  // writeSlimInit already recorded. Here we only extend it with paths that
  // scaffold produced (i.e. those ending in 'CLAUDE.md' and not already
  // present in the manifest).
  const rootClaudePaths = written.filter((p) => p.endsWith('CLAUDE.md'))
  if (rootClaudePaths.length > 0) {
    const existing = readInitManifest(ctx.stateDir)
    const existingSet = new Set(existing)
    const toAdd = rootClaudePaths.filter((p) => !existingSet.has(p))
    if (toAdd.length > 0) {
      writeInitManifest(ctx.stateDir, [...existing, ...toAdd])
    }
  }

  return written
}

/**
 * Seed `.mars/recipes/<name>.md` overrides for every shipped built-in
 * recovery recipe. Same no-overwrite rule as failure-reasons: once the
 * consumer owns the file, the binary leaves it alone. A future binary
 * adding new recipes lands only the missing files. Silent unless
 * something was written.
 */
const runSeedRecipes = async (written: string[]): Promise<string[]> => {
  const ctx = resolveContext()
  const result = writeRecipesSeed(ctx.stateDir)
  if (result.written.length > 0) {
    process.stdout.write(
      `[mars init] wrote ${result.written.length} recipe seeds to ${relative(ctx.repoRoot, result.dir)}/\n`,
    )
  }
  return [
    ...written,
    ...result.written.map((f) => relative(ctx.repoRoot, resolve(result.dir, f))),
  ]
}

/**
 * Best-effort plugin activation. Registers `frameworkClaudeDir` as the Mars
 * Claude Code plugin in the user-level settings file at `userSettingsPath`.
 *
 * Non-fatal: if `frameworkClaudeDir` is not a valid Mars plugin directory
 * (missing `plugin.json` with `"name": "mars"`) OR if the settings file is
 * unwritable, this function prints a one-line warning to stderr and returns
 * without throwing. Repo state written by prior steps is always preserved.
 *
 * Exported so tests can drive it with injected deps without touching the
 * real filesystem or ~/.claude/settings.json.
 */
export function tryActivatePlugin(
  frameworkClaudeDir: string,
  userSettingsPath: string,
  deps: ClaudePluginDeps,
): void {
  try {
    if (!deps.isMarsPlugin(frameworkClaudeDir)) {
      process.stderr.write(
        `[mars init] warning: could not locate Mars plugin directory at ${frameworkClaudeDir}; run \`mars plugin activate <dir>\` manually\n`,
      )
      return
    }
    activatePlugin(frameworkClaudeDir, userSettingsPath, deps)
    process.stdout.write(
      '[mars init] activated Mars Claude Code plugin (mars:* skills now available)\n',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `[mars init] warning: could not activate Mars plugin (${msg}); run \`mars plugin activate <dir>\` manually\n`,
    )
  }
}

const runActivatePlugin = (): void => {
  // init-workflow.ts lives at <frameworkRoot>/orchestrator/src/workflows/
  // walking up three directories reaches <frameworkRoot>.
  // The plugin root is .claude/ — the directory containing both
  // .claude-plugin/ (manifests) and skills/ (skill implementations).
  const thisFile = fileURLToPath(import.meta.url)
  const frameworkClaudeDir = join(dirname(dirname(dirname(thisFile))), '.claude')
  const userSettingsPath = join(homedir(), '.claude', 'settings.json')
  tryActivatePlugin(frameworkClaudeDir, userSettingsPath, realDeps)
}

// Linear steps, threaded by native control flow. The step NAMES
// ('slim-init', 'scaffold-claude', 'merge-mcp-json', 'merge-gitignore',
// 'scaffold-workflows', 'init-databases', 'seed-verify-gates', 'seed-recipes',
// 'activate-plugin')
// are load-bearing trace-view labels. Disk side effects (root CLAUDE.md, the
// .mars/workflows/*.js scaffold, the init manifest, and the recipe override
// seeds) and DB side effects (schema + legacy import) are preserved verbatim.
// Failures THROW; the engine records the step failed. 'activate-plugin' is
// best-effort: it never throws regardless of outcome.
export const initWorkflow = defineWorkflow<InitInput, InitWorkflowOutput>({
  id: 'init',
  inputSchema: initInputSchema,
  fn: async (ctx: WorkflowCtx, input: InitInput): Promise<InitWorkflowOutput> => {
    const w1 = await ctx.step('slim-init', () => {
      const appCtx = resolveContext()
      const slimResult = writeSlimInit({
        repoRoot: appCtx.repoRoot,
        contextPath: resolve(appCtx.repoRoot, 'CONTEXT.md'),
        adrDir: resolve(appCtx.repoRoot, 'docs', 'adr'),
      })
      return slimResult.written
    })
    const w2 = await ctx.step('scaffold-claude', () => runScaffoldClaude(w1))
    const w2b = await ctx.step('merge-mcp-json', () => {
      const appCtx = resolveContext()
      mergeMcpJson(appCtx.repoRoot)
      return [...w2, '.mcp.json']
    })
    const w2d = await ctx.step('merge-gitignore', () => {
      const appCtx = resolveContext()
      applyGitignoreScaffold(appCtx.repoRoot)
      return [...w2b, '.gitignore']
    })
    const w2c = await ctx.step('scaffold-workflows', () => runScaffoldWorkflows(w2d))
    const w3 = await ctx.step('init-databases', () => runInitDatabases(w2c))
    const w4 = await ctx.step('seed-verify-gates', async () => {
      await installOnboardingVerifyGates(input.wizardChoices?.verifyGates ?? WIZARD_DEFAULTS.verifyGates)
      return w3
    })
    const written = await ctx.step('seed-recipes', () => runSeedRecipes(w4))
    await ctx.step('activate-plugin', runActivatePlugin)
    return { written }
  },
})

export interface RunInitOptions {
  force: boolean
  dryRun: boolean
  verbose?: boolean
  /**
   * Resolved wizard answers (ADR-0058). Produced by the wizard controller from
   * the TTY wizard OR fully non-interactively from flags + defaults.
   * When omitted, {@link WIZARD_DEFAULTS} apply, so an old caller that does not
   * pass this gets exactly today's behaviour. Used for `registerProject` gating.
   * Plugin activation is intentionally NOT a wizard choice — it stays automatic.
   */
  wizardChoices?: WizardChoices
}

export interface RunInitResult {
  status: 'ok' | 'aborted-existing' | 'aborted-conflict' | 'dry-run'
  message: string
  written?: string[]
}

export const runInit = async (opts: RunInitOptions): Promise<RunInitResult> => {
  const ctx = resolveContext()

  if (opts.dryRun) {
    return {
      status: 'dry-run',
      message: 'dry run; no files written',
    }
  }

  // Pre-flight: aggregate every path that would be overwritten — everything
  // under `.claude/` plus root `CLAUDE.md` — so we can bail with a single
  // message before the heavy steps spend time on a doomed run.
  if (!opts.force) {
    const conflicts = planClaudeConflicts(ctx.repoRoot)
    if (conflicts.length > 0) {
      const list = conflicts.map((p) => `  - ${p}`).join('\n')
      return {
        status: 'aborted-conflict',
        message: `refusing to overwrite existing files (pass --force to replace):\n${list}`,
      }
    }
  }

  const wizard = opts.wizardChoices ?? WIZARD_DEFAULTS
  const result = await runWorkflow(
    initWorkflow,
    { wizardChoices: wizard },
    { store: createQueueWorkflowStore() },
  )

  if (result.status !== 'completed' || !result.output) {
    const cause = result.error instanceof Error ? `: ${result.error.message}` : ''
    throw new Error(`init workflow ${result.status}${cause}`)
  }

  // Auto-register this repo in the global project registry so the UI can
  // show tasks without requiring a manual 'mars project add'. Idempotent:
  // safe to call on re-init. Gated by the wizard's `registerProject` choice
  // (default true), so a non-interactive `--register-project=false` / config
  // opt-out is honoured.
  if (wizard.registerProject) {
    try {
      ensureProjectRegistered({ repoRoot: ctx.repoRoot })
    } catch (err) {
      process.stderr.write(
        `[mars init] warning: failed to register project in registry: ${(err as Error).message}\n`,
      )
    }
  }

  return {
    status: 'ok',
    message: 'init complete',
    written: result.output.written,
  }
}
