import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

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
  contextPath: string
  adrDir: string
}

export interface SlimInitResult {
  written: string[]
}

const CONTEXT_SKELETON = `# Project Context

Canonical domain terms for this project. Edited via \`mars glossary\`.

## Language
`

export const writeSlimInit = (input: SlimInitInput): SlimInitResult => {
  const written: string[] = []

  if (!existsSync(input.contextPath)) {
    mkdirSync(dirname(input.contextPath), { recursive: true })
    writeFileSync(input.contextPath, CONTEXT_SKELETON, 'utf8')
    written.push(relative(input.repoRoot, input.contextPath))
  }

  mkdirSync(input.adrDir, { recursive: true })

  return { written }
}
