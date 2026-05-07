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

export interface SpecialistSource {
  slug: string
  path: string
}

export interface RenderInput {
  spec: SupervisorSpec
  specialistBody: string | null
  source?: SpecialistSource | null
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
  const { spec, specialistBody, source } = input
  const description = `${roleFromKind[spec.kind]} (${spec.kind}) for this project.`
  const body = (specialistBody ?? '').trim() || fallbackSpecialistBody(spec)
  const sourceFm = source
    ? `source: ayush-that/sub-agents.directory:${source.path}\n`
    : ''
  return getSupervisorSkeleton()
    .replaceAll('{{NAME}}', spec.name)
    .replaceAll('{{DESCRIPTION}}', description)
    .replaceAll('{{ROLE}}', roleFromKind[spec.kind])
    .replaceAll('{{PERSONA}}', spec.persona)
    .replaceAll('{{SOURCE_FRONTMATTER}}', sourceFm)
    .replaceAll('{{WORKFLOW_CONTRACT}}', getWorkflowContract().trim())
    .replaceAll('{{SPECIALIST_BODY}}', body)
}

export const minimalRenderInput = (spec: SupervisorSpec): RenderInput => ({
  spec,
  specialistBody: null,
  source: null,
})

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
