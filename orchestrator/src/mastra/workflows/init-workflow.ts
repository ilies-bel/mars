import { existsSync } from 'node:fs'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { resolveContext } from '../context'
import { initDatabases } from '../../init/databases'
import {
  detectStack,
  type ManifestFinding,
  type SupervisorSpec,
} from '../../init/detect-stack'
import {
  fetchTreesIndex,
  resolveSpecialist,
  type ResolvedSpecialist,
} from '../../init/fetch-specialist'
import {
  renderSupervisor,
  minimalRenderInput,
  validateSupervisor,
} from '../../init/render'
import {
  planClaudeConflicts,
  scaffoldClaudeConfig,
} from '../../init/scaffold'
import { writeSlimInit, writePerFolderClaudeMds, purgeStaleSupervisorMds, type VerifyStepEntry } from '../../init/writer'
import { writeDetectionReport } from '../../init/write-detection-report'
import { relative, resolve } from 'node:path'

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

const detectStep = createStep({
  id: 'detect-stack',
  inputSchema: z.object({
    fetch: z.boolean().default(true),
    refresh: z.boolean().default(false),
  }),
  outputSchema: z.object({
    fetch: z.boolean(),
    refresh: z.boolean(),
    stack: stackSchema,
  }),
  execute: async ({ inputData }) => {
    const ctx = resolveContext()
    const detected = detectStack(ctx.repoRoot)
    const stack = {
      languages: detected.languages,
      frameworks: detected.frameworks,
      infra: detected.infra,
      mobile: detected.mobile,
      specialized: detected.specialized,
      supervisors: ensureBaseline(detected),
    }
    return { fetch: inputData.fetch, refresh: inputData.refresh, stack }
  },
})

const renderStep = createStep({
  id: 'render-supervisors',
  inputSchema: z.object({
    fetch: z.boolean(),
    refresh: z.boolean(),
    stack: stackSchema,
  }),
  outputSchema: z.object({
    stack: stackSchema,
    rendered: z.array(renderedSupervisorSchema),
  }),
  execute: async ({ inputData }) => {
    const ctx = resolveContext()
    const { fetch: doFetch, refresh, stack } = inputData

    const fetchOpts = { refresh, cacheDir: ctx.cacheDir }
    const index = doFetch
      ? await fetchTreesIndex(fetchOpts).catch(
          (): Map<string, string> => new Map(),
        )
      : new Map<string, string>()

    const renderOne = async (
      spec: SupervisorSpec,
    ): Promise<z.infer<typeof renderedSupervisorSchema>> => {
      let resolved: ResolvedSpecialist | null = null
      let tried: string[] = Array.from(spec.externalSlugs)
      let outcome: 'hit' | 'miss' | 'error' = 'miss'

      if (doFetch) {
        try {
          const result = await resolveSpecialist(spec.externalSlugs, index, fetchOpts)
          resolved = result.resolved
          tried = result.tried
          outcome = resolved ? 'hit' : 'miss'
        } catch {
          outcome = 'error'
        }
      }

      const renderInput = resolved
        ? {
            spec,
            specialistBody: resolved.body,
            source: { slug: resolved.slug, path: resolved.path },
          }
        : minimalRenderInput(spec)

      const content = renderSupervisor(renderInput)
      const issue = validateSupervisor(content, spec)
      const verify = verifyDefaultsFor(spec.name)
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
          triedSlugs: tried,
          externalSource: null,
          ...(verify ? { verify } : {}),
        }
      }

      return {
        spec,
        content,
        outcome,
        triedSlugs: tried,
        externalSource: resolved ? { slug: resolved.slug, path: resolved.path } : null,
        ...(verify ? { verify } : {}),
      }
    }

    const rendered = await Promise.all(stack.supervisors.map(renderOne))
    return { stack, rendered }
  },
})

const scopeDepth = (scope: string | undefined): number => {
  if (!scope || scope === '.' || scope === '') return 0
  return scope.split('/').filter(Boolean).length
}

const flattenVerifySteps = (
  rendered: ReadonlyArray<z.infer<typeof renderedSupervisorSchema>>,
): VerifyStepEntry[] => {
  const byName = new Map<string, { entry: VerifyStepEntry; depth: number }>()
  for (const r of rendered) {
    const verify = r.verify
    if (!verify || verify.length === 0) continue
    const depth = scopeDepth(r.spec.scope)
    for (const v of verify) {
      const existing = byName.get(v.name)
      if (!existing || depth < existing.depth) {
        byName.set(v.name, { entry: { ...v, args: [...v.args] }, depth })
      }
    }
  }
  return Array.from(byName.values()).map((e) => e.entry)
}

const writeStep = createStep({
  id: 'write-slim-init',
  inputSchema: z.object({
    stack: stackSchema,
    rendered: z.array(renderedSupervisorSchema),
  }),
  outputSchema: z.object({
    written: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    const ctx = resolveContext()
    const verifySteps = flattenVerifySteps(inputData.rendered)
    const slimResult = writeSlimInit({
      repoRoot: ctx.repoRoot,
      verifyConfigPath: ctx.verifyConfigPath,
      contextPath: resolve(ctx.repoRoot, 'CONTEXT.md'),
      adrDir: resolve(ctx.repoRoot, 'docs', 'adr'),
      verifySteps,
    })
    const perFolderResult = writePerFolderClaudeMds({
      repoRoot: ctx.repoRoot,
      supervisors: inputData.rendered.map((r) => r.spec),
    })
    return { written: [...slimResult.written, ...perFolderResult.written] }
  },
})

/**
 * Copy the framework's bundled Claude Code config (`.claude/**` + root
 * `CLAUDE.md`) into the target repo. `runInit` pre-flights conflicts so by
 * the time this step runs, the user has either accepted overwrite via
 * `--force` or there is nothing to overwrite — we therefore call
 * `scaffoldClaudeConfig` with `force: true` and treat any residual conflict
 * (e.g. a file that appeared between pre-flight and now) as a hard error.
 */
const scaffoldClaudeStep = createStep({
  id: 'scaffold-claude',
  inputSchema: z.object({
    written: z.array(z.string()),
  }),
  outputSchema: z.object({
    written: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    const ctx = resolveContext()
    const result = scaffoldClaudeConfig({
      repoRoot: ctx.repoRoot,
      force: true,
    })
    if (result.status === 'conflict') {
      throw new Error(
        `scaffold-claude: unexpected conflict after pre-flight: ${result.conflicts.join(', ')}`,
      )
    }
    return { written: [...inputData.written, ...result.written] }
  },
})

/**
 * Materialise `.mars/queue.db` + `.mars/state.db` (tasks, ideas, inbox) so a
 * freshly scaffolded repo is usable without waiting for the first daemon
 * write to lazily create them. All three init paths are idempotent via
 * `CREATE TABLE IF NOT EXISTS`.
 */
const initDatabasesStep = createStep({
  id: 'init-databases',
  inputSchema: z.object({
    written: z.array(z.string()),
  }),
  outputSchema: z.object({
    written: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    const ctx = resolveContext()
    await initDatabases()
    const dbWrites = [
      relative(ctx.repoRoot, ctx.queueDbPath),
      relative(ctx.repoRoot, ctx.stateDbPath),
    ]
    return { written: [...inputData.written, ...dbWrites] }
  },
})

export const initWorkflow = createWorkflow({
  id: 'init',
  inputSchema: z.object({
    fetch: z.boolean().default(true),
    refresh: z.boolean().default(false),
  }),
  outputSchema: z.object({
    written: z.array(z.string()),
  }),
})
  .then(detectStep)
  .then(renderStep)
  .then(writeStep)
  .then(scaffoldClaudeStep)
  .then(initDatabasesStep)
  .commit()

export interface RunInitOptions {
  force: boolean
  fetch: boolean
  dryRun: boolean
  refresh: boolean
  verbose?: boolean
}

export interface RunInitResult {
  status: 'ok' | 'aborted-existing' | 'aborted-conflict' | 'dry-run'
  message: string
  written?: string[]
}

export const runInit = async (opts: RunInitOptions): Promise<RunInitResult> => {
  const ctx = resolveContext()

  const detectedForReport = detectStack(ctx.repoRoot, {
    onManifest: opts.verbose
      ? (m: ManifestFinding) => {
          process.stderr.write(`[mars init] ${m.dir}: ${m.techs.join(', ')}\n`)
        }
      : undefined,
  })

  if (opts.dryRun) {
    return {
      status: 'dry-run',
      message: 'dry run; no files written',
    }
  }

  // Migration: remove stale per-stack supervisor .md files written by the
  // old init system. Runs before the pre-flight conflict check so an existing
  // verify.json is preserved as-is (no regeneration of verifySteps).
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

  // Pre-flight: aggregate every path that would be overwritten — the slim
  // `verify.json` plus everything under `.claude/` plus root `CLAUDE.md` —
  // so we can bail with a single message before the heavy detect/render
  // steps spend time on a doomed run.
  if (!opts.force) {
    const conflicts: string[] = []
    if (existsSync(ctx.verifyConfigPath)) {
      conflicts.push(relative(ctx.repoRoot, ctx.verifyConfigPath))
    }
    conflicts.push(...planClaudeConflicts(ctx.repoRoot))
    if (conflicts.length > 0) {
      const list = conflicts.map((p) => `  - ${p}`).join('\n')
      // Preserve `aborted-existing` for the verify-only path so existing
      // callers / tests that special-case it keep working; promote to
      // `aborted-conflict` only when scaffold targets are involved.
      if (conflicts.length === 1 && conflicts[0] === relative(ctx.repoRoot, ctx.verifyConfigPath)) {
        return {
          status: 'aborted-existing',
          message: `verify config already exists at ${ctx.verifyConfigPath}; pass --force to overwrite`,
        }
      }
      return {
        status: 'aborted-conflict',
        message: `refusing to overwrite existing files (pass --force to replace):\n${list}`,
      }
    }
  }

  const { mastra } = await import('../index')
  const wf = mastra.getWorkflow('initWorkflow')
  const run = await wf.createRun()
  const result = await run.start({
    inputData: { fetch: opts.fetch, refresh: opts.refresh },
  })

  if (result.status !== 'success') {
    throw new Error(`init workflow ${result.status}`)
  }
  return {
    status: 'ok',
    message: 'verify config generated',
    written: result.result.written,
  }
}
