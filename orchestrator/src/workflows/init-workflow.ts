import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineWorkflow, runWorkflow, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'
import { createQueueWorkflowStore } from './queue-workflow-store'
import { resolveContext } from '../core/context'
import { initDatabases } from '../init/databases'
import { WIZARD_DEFAULTS, type WizardChoices } from '../init/wizard'
import { VerifyGateInputSchema } from '../core/verify-gates'
import type { VerifyGateInput } from '../core/verify-gates'
import { proposeOnboardingVerifyGates } from '../init/seed-verify-gates'
import { computeMissingGates } from '../init/compute-missing-gates'
import {
  applyGitignoreScaffold,
  planClaudeConflicts,
} from '../init/scaffold'
import { writeSlimInit } from '../init/writer'
import { writeInitManifest } from '../init/init-manifest'
import { queueScaffoldProposals } from '../init/queue-scaffold-proposals'
import { activatePlugin, type ClaudePluginDeps } from '../commands/claude-plugin.js'
import { ensureProjectRegistered } from '../registry/projects.js'
import { detectCurrentBranch } from '../init/detect-branch.js'
import { persistIntegrationBranch } from '../core/daemon/config.js'

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
  dispatched?: { taskId: string; gateName: string } | null
}

/**
 * Copy the framework's bundled Claude Code config (`.claude/**` + root
 * `CLAUDE.md`) into the target repo. `runInit` pre-flights conflicts so by
 * the time this step runs, the user has either accepted overwrite via
 * `--force` or there is nothing to overwrite — we therefore call
 * `scaffoldClaudeConfig` with `force: true` and treat any residual conflict
 * (e.g. a file that appeared between pre-flight and now) as a hard error.
 */

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
  return written
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

// ---------------------------------------------------------------------------
// Slim init workflow (progressive — writes minimum then offers the rest via
// the action queue as draft-proposals).
//
// Step names are load-bearing trace-view labels:
//   'slim-init'          — CONTEXT.md skeleton + docs/knowledge/decisions/
//   'merge-gitignore'    — .gitignore blocks (.mars/, node_modules/, JVM)
//   'init-databases'     — embedded PostgreSQL schema + legacy SQLite import
//   'seed-verify-gates'  — propose onboarding verify gates
//   'queue-setup-suggestions' — draft-proposals for deferred scaffold items
//
// Removed from default path (now offered as action-queue proposals):
//   scaffold-claude, merge-mcp-json, scaffold-workflows, seed-recipes,
//   activate-plugin, dispatch-first-gate (auto-dispatch of a coding task)
// ---------------------------------------------------------------------------
const initWorkflow = defineWorkflow<InitInput, InitWorkflowOutput>({
  id: 'init',
  inputSchema: initInputSchema,
  fn: async (ctx: WorkflowCtx, input: InitInput): Promise<InitWorkflowOutput> => {
    // Detect the repo's default branch before any other step so all subsequent
    // steps (including enqueueTask) target the right integration branch.
    await ctx.step('detect-integration-branch', () => {
      // INTEGRATION_BRANCH env already wins at dispatch time; only persist
      // from git detection when the env var is not set.
      if (process.env.INTEGRATION_BRANCH) return
      const appCtx = resolveContext()
      const branch = detectCurrentBranch(appCtx.repoRoot)
      if (branch !== null && branch !== 'main') {
        persistIntegrationBranch(branch)
        process.stdout.write(
          `Integration branch: ${branch} (detected). Change with: mars operator set integration-branch <name>\n`,
        )
      }
    })

    // 1. Write the minimum viable Mars scaffold: CONTEXT.md skeleton + ADR dir.
    const w1 = await ctx.step('slim-init', () => {
      const appCtx = resolveContext()
      const slimResult = writeSlimInit({
        repoRoot: appCtx.repoRoot,
        contextPath: resolve(appCtx.repoRoot, 'CONTEXT.md'),
        adrDir: resolve(appCtx.repoRoot, 'docs', 'knowledge', 'decisions'),
      })
      return slimResult.written
    })

    // 2. Apply .gitignore blocks (.mars/, node_modules/, JVM crash dumps).
    const w2 = await ctx.step('merge-gitignore', () => {
      const appCtx = resolveContext()
      applyGitignoreScaffold(appCtx.repoRoot)
      return [...w1, '.gitignore']
    })

    // 3. Initialise the embedded DB schema.
    const w3 = await ctx.step('init-databases', () => runInitDatabases(w2))

    // 4. Record the minimal written paths in the init manifest so subsequent
    //    `mars init` runs can detect a prior successful run.
    await ctx.step('write-init-manifest', () => {
      const appCtx = resolveContext()
      writeInitManifest(appCtx.stateDir, w3)
    })

    // 5. Propose onboarding verify gates (DB must be initialised first).
    await ctx.step('seed-verify-gates', async () => {
      const detected = input.wizardChoices?.verifyGates ?? WIZARD_DEFAULTS.verifyGates
      const appCtx = resolveContext()
      const { entries: missingEntries } = computeMissingGates(detected, appCtx.repoRoot)

      let gatesToInstall: VerifyGateInput[] = [...detected]
      const firstMissing = missingEntries[0] ?? null
      if (firstMissing?.recipe?.verifyGate) {
        const vg = firstMissing.recipe.verifyGate
        gatesToInstall = [
          ...detected,
          {
            name: vg.name,
            cmd: vg.cmd,
            args: vg.args,
            scope: vg.scope,
            source: 'onboarding',
            required: true,
            tier: 'task',
          },
        ]
      }

      await proposeOnboardingVerifyGates(gatesToInstall)
    })

    // 6. Queue action-queue draft-proposals for every deferred scaffold item
    //    (CLAUDE.md, .mcp.json, workflow templates, plugin, project registry).
    //    Each shows up as a separate row in `mars action-queue list` so the
    //    operator can accept them one at a time. Non-fatal: a proposal error
    //    never aborts init.
    await ctx.step('queue-setup-suggestions', async () => {
      const appCtx = resolveContext()
      const { raised } = await queueScaffoldProposals(appCtx.repoRoot)
      if (raised.length > 0) {
        process.stdout.write(
          `[mars init] ${raised.length} setup suggestion(s) added to action queue — run \`mars action-queue list\` to review\n`,
        )
      }
    })

    return { written: w3, dispatched: null }
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
  dispatched?: { taskId: string; gateName: string } | null
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
    const rawCause = result.error instanceof Error ? result.error.message : ''
    const causeStr = rawCause ? `: ${rawCause}` : ''

    // When the init fails, check whether the real cause is host file-descriptor
    // exhaustion rather than a database problem. The enrichment probe is
    // non-fatal: if it throws, the import fails, or the platform is unsupported,
    // we fall through to today's message unchanged.
    if (result.status === 'failed' && rawCause) {
      let enrichedMessage: string | null = null
      try {
        const { enrichInitDbError } = await import('../core/lib/fd-headroom')
        const enriched = enrichInitDbError(rawCause)
        if (enriched !== rawCause) enrichedMessage = `init workflow failed: ${enriched}`
      } catch {
        // import or enrichment threw — keep the original message below
      }
      if (enrichedMessage !== null) throw new Error(enrichedMessage)
    }

    throw new Error(`init workflow ${result.status}${causeStr}`)
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
    dispatched: result.output.dispatched,
  }
}
