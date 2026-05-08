import { existsSync } from 'node:fs'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { resolveContext } from '../context'
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
import { writeSupervisors } from '../../init/writer'

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
})

interface VerifyStepEntry {
  name: string
  cmd: string
  args: string[]
  required: boolean
}

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

const writeStep = createStep({
  id: 'write-manifest',
  inputSchema: z.object({
    stack: stackSchema,
    rendered: z.array(renderedSupervisorSchema),
  }),
  outputSchema: z.object({
    supervisorsDir: z.string(),
    written: z.array(z.string()),
    outcomes: z.array(
      z.object({
        name: z.string(),
        outcome: outcomeSchema,
        triedSlugs: z.array(z.string()),
        externalSource: externalSourceSchema,
      }),
    ),
  }),
  execute: async ({ inputData }) => {
    const ctx = resolveContext()
    const result = writeSupervisors(
      {
        repoRoot: ctx.repoRoot,
        supervisorsDir: ctx.supervisorsDir,
        supervisorsManifest: ctx.supervisorsManifest,
      },
      {
        languages: inputData.stack.languages,
        frameworks: inputData.stack.frameworks,
        infra: inputData.stack.infra,
        mobile: inputData.stack.mobile,
        specialized: inputData.stack.specialized,
      },
      inputData.rendered.map((r) => ({
        spec: r.spec,
        content: r.content,
        outcome: r.outcome,
        triedSlugs: r.triedSlugs,
        externalSource: r.externalSource,
        verify: r.verify,
      })),
    )
    return {
      supervisorsDir: result.supervisorsDir,
      written: result.written,
      outcomes: result.outcomes,
    }
  },
})

export const initWorkflow = createWorkflow({
  id: 'init',
  inputSchema: z.object({
    fetch: z.boolean().default(true),
    refresh: z.boolean().default(false),
  }),
  outputSchema: z.object({
    supervisorsDir: z.string(),
    written: z.array(z.string()),
    outcomes: z.array(
      z.object({
        name: z.string(),
        outcome: outcomeSchema,
        triedSlugs: z.array(z.string()),
        externalSource: externalSourceSchema,
      }),
    ),
  }),
})
  .then(detectStep)
  .then(renderStep)
  .then(writeStep)
  .commit()

export interface RunInitOptions {
  force: boolean
  fetch: boolean
  dryRun: boolean
  refresh: boolean
  verbose?: boolean
}

export interface RunInitOutcome {
  name: string
  outcome: 'hit' | 'miss' | 'error'
  triedSlugs: string[]
  externalSource: { slug: string; path: string } | null
}

export interface RunInitResult {
  status: 'ok' | 'aborted-existing' | 'dry-run'
  message: string
  supervisorsDir?: string
  written?: string[]
  outcomes?: RunInitOutcome[]
  detected?: ReturnType<typeof detectStack>
}

export const runInit = async (opts: RunInitOptions): Promise<RunInitResult> => {
  const ctx = resolveContext()
  const detected = detectStack(ctx.repoRoot, {
    onManifest: opts.verbose
      ? (m: ManifestFinding) => {
          process.stderr.write(`[mars init] ${m.dir}: ${m.techs.join(', ')}\n`)
        }
      : undefined,
  })

  for (const w of detected.warnings) {
    if (w.kind === 'depth-cap') {
      process.stderr.write(
        `[mars init] warning: walk depth cap reached; not descended into ${w.paths.length} dir(s) (e.g. ${w.paths[0]})\n`,
      )
    }
  }

  if (opts.dryRun) {
    return {
      status: 'dry-run',
      message: 'dry run; no files written',
      detected,
    }
  }

  if (existsSync(ctx.supervisorsManifest) && !opts.force) {
    return {
      status: 'aborted-existing',
      message: `supervisors already exist at ${ctx.supervisorsDir}; pass --force to overwrite`,
      detected,
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
    message: 'supervisors generated',
    supervisorsDir: result.result.supervisorsDir,
    written: result.result.written,
    outcomes: result.result.outcomes,
    detected,
  }
}
