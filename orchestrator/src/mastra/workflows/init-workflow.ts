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
import { writeSlimInit, type VerifyStepEntry } from '../../init/writer'
import { resolve } from 'node:path'

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
    const result = writeSlimInit({
      repoRoot: ctx.repoRoot,
      verifyConfigPath: ctx.verifyConfigPath,
      contextPath: resolve(ctx.repoRoot, 'CONTEXT.md'),
      adrDir: resolve(ctx.repoRoot, 'docs', 'adr'),
      verifySteps,
    })
    return { written: result.written }
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
  .commit()

export interface RunInitOptions {
  force: boolean
  fetch: boolean
  dryRun: boolean
  refresh: boolean
  verbose?: boolean
}

export interface RunInitResult {
  status: 'ok' | 'aborted-existing' | 'dry-run'
  message: string
  written?: string[]
}

export const runInit = async (opts: RunInitOptions): Promise<RunInitResult> => {
  const ctx = resolveContext()

  if (opts.verbose) {
    detectStack(ctx.repoRoot, {
      onManifest: (m: ManifestFinding) => {
        process.stderr.write(`[mars init] ${m.dir}: ${m.techs.join(', ')}\n`)
      },
    })
  }

  if (opts.dryRun) {
    return {
      status: 'dry-run',
      message: 'dry run; no files written',
    }
  }

  if (existsSync(ctx.verifyConfigPath) && !opts.force) {
    return {
      status: 'aborted-existing',
      message: `verify config already exists at ${ctx.verifyConfigPath}; pass --force to overwrite`,
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
