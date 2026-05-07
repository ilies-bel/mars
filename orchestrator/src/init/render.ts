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
  specialty: string
  techStack: string
  scopeHandles: string
  scopeEscalates: string
  standards: string
}

export const renderSupervisor = (input: RenderInput): string => {
  const { spec, specialty, techStack, scopeHandles, scopeEscalates, standards } = input
  const description = `${roleFromKind[spec.kind]} for ${spec.externalQuery}.`
  return getSupervisorSkeleton()
    .replaceAll('{{NAME}}', spec.name)
    .replaceAll('{{DESCRIPTION}}', description)
    .replaceAll('{{ROLE}}', roleFromKind[spec.kind])
    .replaceAll('{{PERSONA}}', spec.persona)
    .replaceAll('{{SPECIALTY}}', specialty.trim() || spec.externalQuery)
    .replaceAll('{{WORKFLOW_CONTRACT}}', getWorkflowContract().trim())
    .replaceAll('{{TECH_STACK}}', techStack.trim() || '_(no external specialist details available)_')
    .replaceAll('{{SCOPE_HANDLES}}', scopeHandles.trim() || `Tasks within the ${spec.kind} domain for this project.`)
    .replaceAll('{{SCOPE_ESCALATES}}', scopeEscalates.trim() || 'Cross-domain decisions, architecture changes, schema migrations, infra/security reviews.')
    .replaceAll('{{STANDARDS}}', standards.trim() || 'Follow the project\'s established conventions, lint rules, and test coverage expectations.')
}

export const minimalRenderInput = (spec: SupervisorSpec): RenderInput => ({
  spec,
  specialty: spec.externalQuery,
  techStack: spec.detectedFrom.map((d) => `- detected via \`${d}\``).join('\n'),
  scopeHandles: `- Implementation work in the ${spec.kind} domain (${spec.externalQuery}).`,
  scopeEscalates: '- Cross-domain refactors, architecture changes, infrastructure or security decisions.',
  standards: '- Match existing codebase patterns; do not introduce new dependencies without justification.\n- Maintain or improve test coverage.\n- Keep changes scoped to the task prompt.',
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
  if (lines > 250) {
    return { reason: `supervisor too long (${lines} lines, max 250)` }
  }
  return null
}

const stripCodeBlocksOver = (text: string, maxLines: number): string => {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  let fenceBuf: string[] = []
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inFence) {
        if (fenceBuf.length <= maxLines) {
          out.push('```' + (fenceBuf[0] ?? ''))
          for (let i = 1; i < fenceBuf.length; i++) out.push(fenceBuf[i])
          out.push(line)
        }
        fenceBuf = []
        inFence = false
      } else {
        inFence = true
        fenceBuf = [line.trim().slice(3)]
      }
      continue
    }
    if (inFence) {
      fenceBuf.push(line)
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

export const filterExternalMarkdown = (text: string): string => {
  let cleaned = stripCodeBlocksOver(text, 3)
  const sectionTitles = [
    'example',
    'examples',
    'pattern',
    'patterns',
    'how to',
    'how-to',
    'usage',
    'common mistakes',
  ]
  const lines = cleaned.split('\n')
  const out: string[] = []
  let skipping = false
  let skipLevel = 0
  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      const title = heading[2].toLowerCase().trim()
      if (skipping && level <= skipLevel) {
        skipping = false
      }
      if (!skipping && sectionTitles.some((t) => title.startsWith(t) || title === t)) {
        skipping = true
        skipLevel = level
        continue
      }
    }
    if (skipping) continue
    out.push(line)
  }
  cleaned = out.join('\n')
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  return cleaned.trim()
}
