import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { defineWorkflow, runWorkflow, type WorkflowCtx } from '@mars/workflow'
import { z } from 'zod'
import { createQueueWorkflowStore } from './queue-workflow-store'
import { resolveContext } from '../core/context'
import { initDatabases } from '../init/databases'
import {
  detectStack,
  type ManifestFinding,
  type StackDetection,
  type SupervisorSpec,
} from '../init/detect-stack'
import { loadInitConfig } from '../init/init-config'
import { WIZARD_DEFAULTS, type WizardChoices } from '../init/wizard'
import {
  renderSupervisor,
  minimalRenderInput,
  validateSupervisor,
} from '../init/render'
import {
  mergeMcpJson,
  planClaudeConflicts,
  scaffoldClaudeConfig,
} from '../init/scaffold'
import { planWorkflowCopies, scaffoldWorkflows } from '../init/scaffold-workflows'
import { enrichRootClaudeMd, type ProjectLayoutEntry } from '../init/project-layout'
import { writeSlimInit, writePerFolderClaudeMds, purgeStaleSupervisorMds, type VerifyStepEntry } from '../init/writer'
import { writeDetectionReport } from '../init/write-detection-report'
import { readInitManifest, writeInitManifest } from '../init/init-manifest'
import { writeRecipesSeed } from '../init/recipes-seed'
import { activatePlugin, realDeps, type ClaudePluginDeps } from '../commands/claude-plugin.js'
import { ensureProjectRegistered } from '../registry/projects.js'

const verifyStepSchema = z.object({
  name: z.string(),
  cmd: z.string(),
  args: z.array(z.string()),
  required: z.boolean(),
})

const supervisorSpecSchema = z.object({
  name: z.string(),
  persona: z.string(),
  kind: z.enum(['frontend', 'backend', 'infra', 'mobile', 'specialized']),
  scope: z.string(),
  detectedFrom: z.array(z.string()),
  externalSlugs: z.array(z.string()),
  techs: z.array(z.string()),
})

const VERIFY_DEFAULTS_BY_SUPERVISOR: Record<string, VerifyStepEntry[]> = {
  'node-backend-supervisor': [
    { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
    { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
    { name: 'lint', cmd: 'npx', args: ['biome', 'check', '.'], required: false },
  ],
  'react-supervisor': [
    { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
    { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
    { name: 'lint', cmd: 'npx', args: ['biome', 'check', '.'], required: false },
  ],
  'vue-supervisor': [
    { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
    { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
  ],
  'svelte-supervisor': [
    { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
    { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
  ],
  'angular-supervisor': [
    { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
    { name: 'test', cmd: 'npm', args: ['test', '--silent'], required: true },
  ],
  'go-supervisor': [
    { name: 'test', cmd: 'go', args: ['test', './...'], required: true },
    { name: 'vet', cmd: 'go', args: ['vet', './...'], required: false },
  ],
  'rust-supervisor': [
    { name: 'test', cmd: 'cargo', args: ['test'], required: true },
    { name: 'clippy', cmd: 'cargo', args: ['clippy', '--', '-D', 'warnings'], required: false },
  ],
  'python-backend-supervisor': [
    { name: 'test', cmd: 'pytest', args: ['-q'], required: true },
  ],
  'jvm-backend-supervisor': [
    { name: 'build', cmd: './gradlew', args: ['build'], required: true },
    { name: 'test', cmd: './gradlew', args: ['test'], required: true },
  ],
  'flutter-supervisor': [
    { name: 'analyze', cmd: 'flutter', args: ['analyze'], required: true },
    { name: 'test', cmd: 'flutter', args: ['test'], required: true },
  ],
  'ios-supervisor': [],
  'android-supervisor': [
    { name: 'build', cmd: './gradlew', args: ['assembleDebug'], required: true },
  ],
}

const verifyDefaultsFor = (supervisorName: string): VerifyStepEntry[] | undefined =>
  VERIFY_DEFAULTS_BY_SUPERVISOR[supervisorName]

const stackSchema = z.object({
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  infra: z.array(z.string()),
  mobile: z.array(z.string()),
  specialized: z.array(z.string()),
  supervisors: z.array(supervisorSpecSchema),
})

const externalSourceSchema = z
  .object({ slug: z.string(), path: z.string() })
  .nullable()

const outcomeSchema = z.enum(['hit', 'miss', 'error'])

const renderedSupervisorSchema = z.object({
  spec: supervisorSpecSchema,
  content: z.string(),
  outcome: outcomeSchema,
  triedSlugs: z.array(z.string()),
  externalSource: externalSourceSchema,
  verify: z.array(verifyStepSchema).optional(),
})

const BASELINE_SUPERVISOR: SupervisorSpec = {
  name: 'baseline-supervisor',
  persona: 'Echo',
  kind: 'specialized',
  scope: '.',
  detectedFrom: ['baseline'],
  externalSlugs: ['code-reviewer', 'fullstack-developer'],
  techs: [],
}

const ensureBaseline = (stack: {
  supervisors: SupervisorSpec[]
}): SupervisorSpec[] => {
  if (stack.supervisors.length > 0) return stack.supervisors
  return [BASELINE_SUPERVISOR]
}

type DetectedStack = z.infer<typeof stackSchema>
type RenderedSupervisor = z.infer<typeof renderedSupervisorSchema>

/**
 * Apply the wizard's `supervisors` choice as an allow-list over the detected
 * supervisor set. An empty list (the default) keeps every detected supervisor.
 * Names that match nothing are ignored; `ensureBaseline` still backfills the
 * baseline supervisor when the filter empties the set entirely.
 */
const applySupervisorFilter = (
  supervisors: SupervisorSpec[],
  keep: readonly string[],
): SupervisorSpec[] => {
  if (keep.length === 0) return supervisors
  const allow = new Set(keep)
  const filtered = supervisors.filter((s) => allow.has(s.name))
  return filtered
}

const runDetectStack = async (
  configPath?: string,
  wizard?: WizardChoices,
): Promise<DetectedStack> => {
  const ctx = resolveContext()
  const detected = configPath
    ? loadInitConfig(configPath, ctx.repoRoot)
    : detectStack(ctx.repoRoot)
  const keep = wizard?.supervisors ?? WIZARD_DEFAULTS.supervisors
  return {
    languages: detected.languages,
    frameworks: detected.frameworks,
    infra: detected.infra,
    mobile: detected.mobile,
    specialized: detected.specialized,
    supervisors: ensureBaseline({
      supervisors: applySupervisorFilter(detected.supervisors, keep),
    }),
  }
}

const runRenderSupervisors = async (
  stack: DetectedStack,
  scaffoldMode: WizardChoices['scaffoldMode'] = WIZARD_DEFAULTS.scaffoldMode,
): Promise<RenderedSupervisor[]> => {
    const renderOne = (spec: SupervisorSpec): RenderedSupervisor => {
      const renderInput = minimalRenderInput(spec)
      const content = renderSupervisor(renderInput)
      const issue = validateSupervisor(content, spec)
      // 'minimal' scaffold mode omits the default verify-step contract; 'full'
      // (the default) keeps today's behaviour of seeding verify defaults.
      const verify =
        scaffoldMode === 'minimal' ? undefined : verifyDefaultsFor(spec.name)
      if (issue) {
        const fallback = renderSupervisor(minimalRenderInput(spec))
        const fallbackIssue = validateSupervisor(fallback, spec)
        if (fallbackIssue) {
          throw new Error(
            `supervisor ${spec.name} failed validation even from minimal template: ${fallbackIssue.reason}`,
          )
        }
        return {
          spec,
          content: fallback,
          outcome: 'error',
          triedSlugs: Array.from(spec.externalSlugs),
          externalSource: null,
          ...(verify ? { verify } : {}),
        }
      }

      return {
        spec,
        content,
        outcome: 'miss',
        triedSlugs: Array.from(spec.externalSlugs),
        externalSource: null,
        ...(verify ? { verify } : {}),
      }
    }

    return stack.supervisors.map(renderOne)
}

const runWriteSlimInit = async (rendered: RenderedSupervisor[]): Promise<string[]> => {
  const ctx = resolveContext()
  const slimResult = writeSlimInit({
    repoRoot: ctx.repoRoot,
    contextPath: resolve(ctx.repoRoot, 'CONTEXT.md'),
    adrDir: resolve(ctx.repoRoot, 'docs', 'adr'),
  })
  const perFolderResult = writePerFolderClaudeMds({
    repoRoot: ctx.repoRoot,
    marsDir: ctx.stateDir,
    supervisors: rendered.map((r) => r.spec),
  })
  return [...slimResult.written, ...perFolderResult.written]
}

/**
 * Copy the framework's bundled Claude Code config (`.claude/**` + root
 * `CLAUDE.md`) into the target repo. `runInit` pre-flights conflicts so by
 * the time this step runs, the user has either accepted overwrite via
 * `--force` or there is nothing to overwrite — we therefore call
 * `scaffoldClaudeConfig` with `force: true` and treat any residual conflict
 * (e.g. a file that appeared between pre-flight and now) as a hard error.
 *
 * After the base CLAUDE.md is written, a project-layout block is inserted
 * (or replaced on re-run) between stable HTML marker comments so the file
 * lists the detected stacks, their folders, supervisors, and verify commands.
 */
const runScaffoldClaude = async (
  rendered: RenderedSupervisor[],
  written: string[],
): Promise<string[]> => {
  const ctx = resolveContext()
  const result = scaffoldClaudeConfig({ repoRoot: ctx.repoRoot, force: true })
  if (result.status === 'conflict') {
    throw new Error(
      `scaffold-claude: unexpected conflict after pre-flight: ${result.conflicts.join(', ')}`,
    )
  }

  // Enrich the root CLAUDE.md with a detected-stacks summary block.
  // This is additive and idempotent: re-running replaces only the marker block.
  const layoutEntries: ProjectLayoutEntry[] = rendered.map((r) => ({
    folder: r.spec.scope,
    techs: r.spec.techs,
    supervisorName: r.spec.name,
    persona: r.spec.persona,
    verifyCommands: (r.verify ?? []).map((v) => `${v.cmd} ${v.args.join(' ')}`),
  }))
  const claudeMdPath = resolve(ctx.repoRoot, 'CLAUDE.md')
  enrichRootClaudeMd(claudeMdPath, layoutEntries)

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
 * Materialise `.mars/queue.db` + `.mars/state.db` (tasks, ideas, actionQueue) so a
 * freshly scaffolded repo is usable without waiting for the first daemon
 * write to lazily create them. All three init paths are idempotent via
 * `CREATE TABLE IF NOT EXISTS`.
 */
const runInitDatabases = async (written: string[]): Promise<string[]> => {
  const ctx = resolveContext()
  await initDatabases()
  const dbWrites = [
    relative(ctx.repoRoot, ctx.queueDbPath),
    relative(ctx.repoRoot, ctx.stateDbPath),
  ]

  // Merge any root-level CLAUDE.md (written by scaffold) into the init
  // manifest so it is listed alongside the per-folder CLAUDE.md files that
  // writePerFolderClaudeMds already recorded. The per-folder manifest was
  // written earlier in write-slim-init; here we only extend it with paths that
  // scaffold produced (i.e. those ending in 'CLAUDE.md' and not already
  // present in the manifest).
  const allWritten = [...written, ...dbWrites]
  const rootClaudePaths = allWritten.filter((p) => p.endsWith('CLAUDE.md'))
  if (rootClaudePaths.length > 0) {
    const existing = readInitManifest(ctx.stateDir)
    const existingSet = new Set(existing)
    const toAdd = rootClaudePaths.filter((p) => !existingSet.has(p))
    if (toAdd.length > 0) {
      writeInitManifest(ctx.stateDir, [...existing, ...toAdd])
    }
  }

  return allWritten
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

// Mirrors WizardChoices exactly (supervisors is readonly there) so a resolved
// WizardChoices feeds the workflow input without a structural-type mismatch.
const wizardChoicesSchema = z.object({
  supervisors: z.array(z.string()).readonly(),
  registerProject: z.boolean(),
  scaffoldMode: z.enum(['full', 'minimal']),
})

const initInputSchema = z.object({
  configPath: z.string().optional(),
  wizardChoices: wizardChoicesSchema.optional(),
})

type InitInput = z.infer<typeof initInputSchema>

interface InitWorkflowOutput {
  written: string[]
}

// Linear steps, threaded by native control flow. The step NAMES
// ('detect-stack', 'render-supervisors', 'write-slim-init', 'scaffold-claude',
// 'scaffold-workflows', 'init-databases', 'seed-recipes', 'activate-plugin')
// are load-bearing trace-view labels. Disk side effects (per-folder + root
// CLAUDE.md, the .mars/workflows/*.js scaffold, the init manifest, and the
// recipe override seeds) and DB side effects (queue.db/state.db) are preserved
// verbatim. Failures THROW; the engine records the step failed. 'activate-plugin'
// is best-effort: it never throws regardless of outcome.
export const initWorkflow = defineWorkflow<InitInput, InitWorkflowOutput>({
  id: 'init',
  inputSchema: initInputSchema,
  fn: async (ctx: WorkflowCtx, input: InitInput): Promise<InitWorkflowOutput> => {
    const wizard = input.wizardChoices ?? WIZARD_DEFAULTS
    const stack = await ctx.step('detect-stack', () =>
      runDetectStack(input.configPath, wizard),
    )
    const rendered = await ctx.step('render-supervisors', () =>
      runRenderSupervisors(stack, wizard.scaffoldMode),
    )
    const w1 = await ctx.step('write-slim-init', () => runWriteSlimInit(rendered))
    const w2 = await ctx.step('scaffold-claude', () => runScaffoldClaude(rendered, w1))
    const w2b = await ctx.step('merge-mcp-json', () => {
      const appCtx = resolveContext()
      mergeMcpJson(appCtx.repoRoot)
      return [...w2, '.mcp.json']
    })
    const w2c = await ctx.step('scaffold-workflows', () => runScaffoldWorkflows(w2b))
    const w3 = await ctx.step('init-databases', () => runInitDatabases(w2c))
    const written = await ctx.step('seed-recipes', () => runSeedRecipes(w3))
    await ctx.step('activate-plugin', runActivatePlugin)
    return { written }
  },
})

export interface RunInitOptions {
  force: boolean
  dryRun: boolean
  verbose?: boolean
  /**
   * Path to a declarative TOML init config (`mars init -f <path>`). When set,
   * the stack is read from the config instead of being auto-detected by
   * walking the repo — the escape hatch for layouts the walker rejects (e.g.
   * a root packaging manifest nesting over per-package manifests).
   */
  configPath?: string
  /**
   * Resolved wizard answers (ADR-0058). Produced by the wizard controller from
   * the TTY wizard OR fully non-interactively from flags + config + defaults.
   * When omitted, {@link WIZARD_DEFAULTS} apply, so an old caller that does not
   * pass this gets exactly today's behaviour. Threaded into detect-stack
   * (supervisor allow-list), render-supervisors (scaffold mode), and project
   * registration (`registerProject`). Plugin activation is intentionally NOT a
   * wizard choice — it stays automatic.
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

  // When a declarative config is supplied, the "detection" report reflects the
  // config-derived stack rather than a repo walk — this is what makes the
  // config the escape hatch for layouts the walker would reject.
  let detectedForReport: StackDetection
  if (opts.configPath) {
    detectedForReport = loadInitConfig(opts.configPath, ctx.repoRoot)
    if (opts.verbose) {
      for (const m of detectedForReport.manifests) {
        process.stderr.write(`[mars init] ${m.dir}: ${m.techs.join(', ')}\n`)
      }
    }
  } else {
    detectedForReport = detectStack(ctx.repoRoot, {
      onManifest: opts.verbose
        ? (m: ManifestFinding) => {
            process.stderr.write(`[mars init] ${m.dir}: ${m.techs.join(', ')}\n`)
          }
        : undefined,
    })
  }

  if (opts.dryRun) {
    return {
      status: 'dry-run',
      message: 'dry run; no files written',
    }
  }

  // Migration: remove stale per-stack supervisor .md files written by the
  // old init system.
  const { purged } = purgeStaleSupervisorMds(ctx.supervisorsDir)
  if (purged.length > 0) {
    process.stdout.write(
      `[mars init] migration: removed ${purged.length} stale supervisor .md file(s): ${purged.join(', ')}\n`,
    )
  }

  // Emit a best-effort diagnostic detection report. Failures here must not
  // block init — we surface a warning on stderr and continue. The report is
  // written before pre-flight conflict checks so it always reflects what the
  // detector saw on this run, regardless of whether init proceeds.
  const reportResult = writeDetectionReport({
    reportPath: resolve(ctx.supervisorsDir, 'detection-report.json'),
    manifests: detectedForReport.manifests,
    warnings: detectedForReport.warnings,
  })
  if (reportResult.status === 'error') {
    process.stderr.write(
      `[mars init] warning: failed to write detection report: ${reportResult.error}\n`,
    )
  }

  // Pre-flight: aggregate every path that would be overwritten — everything
  // under `.claude/` plus root `CLAUDE.md` — so we can bail with a single
  // message before the heavy detect/render steps spend time on a doomed run.
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
    {
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
      wizardChoices: wizard,
    },
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
