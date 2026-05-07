import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createWorkflow, createStep } from '@mastra/core/workflows'
import { z } from 'zod'
import { resolveContext } from '../context'
import { detectStack, type SupervisorSpec } from '../../init/detect-stack'
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

const supervisorSpecSchema = z.object({
  name: z.string(),
  persona: z.string(),
  kind: z.enum(['frontend', 'backend', 'infra', 'mobile', 'specialized']),
  detectedFrom: z.array(z.string()),
  externalSlugs: z.array(z.string()),
})

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
})

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
    const stack = detectStack(ctx.repoRoot)
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
        }
      }

      return {
        spec,
        content,
        outcome,
        triedSlugs: tried,
        externalSource: resolved ? { slug: resolved.slug, path: resolved.path } : null,
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
    mkdirSync(ctx.supervisorsDir, { recursive: true })

    const written: string[] = []
    const entries = inputData.rendered.map((r) => {
      const filePath = resolve(ctx.supervisorsDir, `${r.spec.name}.md`)
      writeFileSync(filePath, r.content, 'utf8')
      written.push(relative(ctx.repoRoot, filePath))
      return {
        name: r.spec.name,
        persona: r.spec.persona,
        kind: r.spec.kind,
        path: relative(ctx.repoRoot, filePath),
        outcome: r.outcome,
        triedSlugs: r.triedSlugs,
        externalSource: r.externalSource,
        lines: r.content.split('\n').length,
      }
    })

    const manifest = {
      version: 1 as const,
      generatedAt: new Date().toISOString(),
      stack: {
        languages: inputData.stack.languages,
        frameworks: inputData.stack.frameworks,
        infra: inputData.stack.infra,
        mobile: inputData.stack.mobile,
        specialized: inputData.stack.specialized,
      },
      supervisors: entries,
    }
    writeFileSync(ctx.supervisorsManifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    written.push(relative(ctx.repoRoot, ctx.supervisorsManifest))

    const indexMd = `# Mars Supervisors

This directory holds specialized supervisor system prompts generated by \`mars init\`.

The orchestrator loads them at task-dispatch time. Edit \`manifest.json\` and the per-supervisor \`.md\` files at your own risk — re-run \`mars init --force\` to regenerate.

Generated: ${manifest.generatedAt}

## Detected stack

- Languages: ${manifest.stack.languages.join(', ') || '—'}
- Frameworks: ${manifest.stack.frameworks.join(', ') || '—'}
- Infra: ${manifest.stack.infra.join(', ') || '—'}
- Mobile: ${manifest.stack.mobile.join(', ') || '—'}
- Specialized: ${manifest.stack.specialized.join(', ') || '—'}

## Supervisors

${entries.map((e) => `- **${e.name}** (${e.persona}) — ${e.kind} — ${e.lines} lines — ${e.outcome}${e.externalSource ? ` (${e.externalSource.slug})` : ''}`).join('\n') || '_(none)_'}
`
    const indexPath = resolve(ctx.supervisorsDir, 'README.md')
    writeFileSync(indexPath, indexMd, 'utf8')
    written.push(relative(ctx.repoRoot, indexPath))

    return {
      supervisorsDir: ctx.supervisorsDir,
      written,
      outcomes: entries.map((e) => ({
        name: e.name,
        outcome: e.outcome,
        triedSlugs: e.triedSlugs,
        externalSource: e.externalSource,
      })),
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
  const detected = detectStack(ctx.repoRoot)

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
