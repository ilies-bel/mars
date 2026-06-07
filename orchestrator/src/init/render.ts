import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SupervisorSpec } from './detect-stack'

const moduleDir = (): string => dirname(fileURLToPath(import.meta.url))

const loadTemplate = (name: string): string =>
  readFileSync(resolve(moduleDir(), 'templates', name), 'utf8')

export const WORKFLOW_CONTRACT_SENTINEL = '<!-- mars-workflow-contract:v1 -->'

let cachedSkeleton: string | null = null
let cachedContract: string | null = null

export const getSupervisorSkeleton = (): string => {
  if (cachedSkeleton === null) cachedSkeleton = loadTemplate('supervisor-skeleton.md')
  return cachedSkeleton
}

export const getWorkflowContract = (): string => {
  if (cachedContract === null) cachedContract = loadTemplate('workflow-contract.md')
  return cachedContract
}

const roleFromKind: Record<SupervisorSpec['kind'], string> = {
  frontend: 'Frontend Supervisor',
  backend: 'Backend Supervisor',
  infra: 'Infrastructure Supervisor',
  mobile: 'Mobile Supervisor',
  specialized: 'Specialist Supervisor',
}

export interface RenderInput {
  spec: SupervisorSpec
  specialistBody: string | null
}

const fallbackSpecialistBody = (spec: SupervisorSpec): string => {
  const detected = spec.detectedFrom.length > 0
    ? spec.detectedFrom.map((d) => `\`${d}\``).join(', ')
    : 'project context'
  return `_(no upstream specialist matched; using minimal template)_

This supervisor handles work in the **${spec.kind}** domain, detected via ${detected}.

- Implement only what the task prompt asks for and follow the project's existing conventions.
- Maintain or improve test coverage; do not weaken assertions to make verification pass.
- Escalate cross-domain refactors, architecture changes, and infrastructure or security decisions to the orchestrator.`
}

export const renderSupervisor = (input: RenderInput): string => {
  const { spec, specialistBody } = input
  const description = `${roleFromKind[spec.kind]} (${spec.kind}) for this project.`
  const body = (specialistBody ?? '').trim() || fallbackSpecialistBody(spec)
  return getSupervisorSkeleton()
    .replaceAll('{{NAME}}', spec.name)
    .replaceAll('{{DESCRIPTION}}', description)
    .replaceAll('{{ROLE}}', roleFromKind[spec.kind])
    .replaceAll('{{PERSONA}}', spec.persona)
    .replaceAll('{{WORKFLOW_CONTRACT}}', getWorkflowContract().trim())
    .replaceAll('{{SPECIALIST_BODY}}', body)
}

export const minimalRenderInput = (spec: SupervisorSpec): RenderInput => ({
  spec,
  specialistBody: null,
})

/**
 * A single entry in `manifest.json`'s `scopes[]` array. Declares where a
 * stack lives in the repo (`path`, '.' for the root), what tag identifies
 * the stack, and the shell command for each verify kind (build, test,
 * typecheck, …) that belongs to that scope.
 */
export interface ScopeManifestEntry {
  path: string
  stack: string
  verify: Record<string, string>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate a raw `scopes` value (typically `JSON.parse(manifest.json).scopes`)
 * and return a typed `ScopeManifestEntry[]`. `undefined`, `null`, and an
 * empty array all yield `[]` — there is no implicit detection at this
 * layer. Throws if any entry is missing `path`, `stack`, or `verify`, or
 * if a verify value is not a string.
 */
export const validateScopes = (raw: unknown): ScopeManifestEntry[] => {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw new Error('manifest.json `scopes` must be an array')
  }
  return raw.map((entry, i) => {
    if (!isPlainObject(entry)) {
      throw new Error(`manifest.json scopes[${i}] must be an object`)
    }
    const { path, stack, verify } = entry
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`manifest.json scopes[${i}] is missing required field \`path\``)
    }
    if (typeof stack !== 'string' || stack.length === 0) {
      throw new Error(`manifest.json scopes[${i}] is missing required field \`stack\``)
    }
    if (!isPlainObject(verify)) {
      throw new Error(`manifest.json scopes[${i}] is missing required field \`verify\``)
    }
    const verifyMap: Record<string, string> = {}
    for (const [kind, cmd] of Object.entries(verify)) {
      if (typeof cmd !== 'string' || cmd.length === 0) {
        throw new Error(
          `manifest.json scopes[${i}].verify.${kind} must be a non-empty shell command string`,
        )
      }
      verifyMap[kind] = cmd
    }
    return { path, stack, verify: verifyMap }
  })
}

export interface ValidationIssue {
  reason: string
}

export const validateSupervisor = (
  content: string,
  spec: SupervisorSpec,
): ValidationIssue | null => {
  if (!content.startsWith('---')) {
    return { reason: 'missing YAML frontmatter' }
  }
  const frontmatterEnd = content.indexOf('\n---', 3)
  if (frontmatterEnd === -1) {
    return { reason: 'unterminated YAML frontmatter' }
  }
  const fm = content.slice(3, frontmatterEnd)
  const nameMatch = fm.match(/(?:^|\n)\s*name:\s*([^\n]+)/)
  if (!nameMatch || nameMatch[1].trim() !== spec.name) {
    return { reason: `frontmatter name must be "${spec.name}"` }
  }
  if (!spec.name.endsWith('-supervisor')) {
    return { reason: `supervisor name "${spec.name}" must end with -supervisor` }
  }
  if (!content.includes(WORKFLOW_CONTRACT_SENTINEL)) {
    return { reason: 'missing workflow contract sentinel' }
  }
  const lines = content.split('\n').length
  if (lines > 500) {
    return { reason: `supervisor too long (${lines} lines, max 500)` }
  }
  return null
}
