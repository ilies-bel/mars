import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { DECISIONS_DIR, GLOSSARY_DIR, KNOWLEDGE_ROOT, VISION_PATH } from '../core/lib/knowledge'

export interface VerifyStepEntry {
  name: string
  cmd: string
  args: string[]
  required: boolean
  /**
   * Working directory for the step, relative to the repo root. '.' for the
   * root scope. Optional for legacy supervisor-default steps; required for
   * steps compiled from a manifest.json `scopes[]` entry.
   */
  cwd?: string
  /**
   * 'task': cheap gate (typecheck, lint). Runs in the per-task verify phase.
   * 'integration': expensive gate (full test suite). Deferred to integration
   * boundary; not run during per-task verify. Omit for the default 'task'.
   */
  tier?: 'task' | 'integration'
}

export interface SlimInitInput {
  repoRoot: string
}

export interface SlimInitResult {
  written: string[]
}

const KNOWLEDGE_README = `# Knowledge surface

This directory is the canonical, version-controlled knowledge surface for this project.

- \`glossary/\` stores one Markdown file per canonical domain term. Mutate terms only with \`mars glossary set/remove\`; read with \`mars glossary list/show\`.
- \`decisions/\` stores one Markdown file per architecture decision. Mutate decisions only with \`mars adr add\`; read with \`mars adr list/show\`.
- \`vision.md\` holds the product vision.
`

export const writeSlimInit = (input: SlimInitInput): SlimInitResult => {
  const written: string[] = []

  const readmePath = resolve(input.repoRoot, KNOWLEDGE_ROOT, 'README.md')
  if (!existsSync(readmePath)) {
    mkdirSync(resolve(input.repoRoot, GLOSSARY_DIR), { recursive: true })
    mkdirSync(resolve(input.repoRoot, DECISIONS_DIR), { recursive: true })
    writeFileSync(readmePath, KNOWLEDGE_README, 'utf8')
    written.push(relative(input.repoRoot, readmePath))
  }
  mkdirSync(resolve(input.repoRoot, GLOSSARY_DIR), { recursive: true })
  mkdirSync(resolve(input.repoRoot, DECISIONS_DIR), { recursive: true })
  const visionPath = resolve(input.repoRoot, VISION_PATH)
  if (!existsSync(visionPath)) writeFileSync(visionPath, '# Product vision\n', 'utf8')

  return { written }
}
