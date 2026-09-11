import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

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
