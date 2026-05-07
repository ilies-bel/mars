import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveContext } from '../mastra/context'
import type { SupervisorKind } from './detect-stack'

export interface SupervisorManifestEntry {
  name: string
  persona: string
  kind: SupervisorKind
  path: string
  externalSource: string | null
  filteredFromLines: number | null
  lines: number
}

export interface SupervisorManifest {
  version: 1
  generatedAt: string
  stack: {
    languages: string[]
    frameworks: string[]
    infra: string[]
    mobile: string[]
    specialized: string[]
  }
  supervisors: SupervisorManifestEntry[]
}

export const loadManifest = (): SupervisorManifest | null => {
  const ctx = resolveContext()
  try {
    const raw = readFileSync(ctx.supervisorsManifest, 'utf8')
    return JSON.parse(raw) as SupervisorManifest
  } catch {
    return null
  }
}

export const loadSupervisorPrompt = (name: string): string | null => {
  const ctx = resolveContext()
  try {
    return readFileSync(resolve(ctx.supervisorsDir, `${name}.md`), 'utf8')
  } catch {
    return null
  }
}
