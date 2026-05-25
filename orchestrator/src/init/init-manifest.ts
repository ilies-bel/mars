import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface InitManifest {
  version: 1
  generatedAt: string
  /**
   * Relative paths (from repo root) of every CLAUDE.md that `mars init`
   * wrote on the most recent run. Used on the next run to distinguish
   * Mars-owned files (safe to overwrite) from hand-written files (left alone).
   */
  paths: string[]
}

/**
 * Read the list of CLAUDE.md paths that `mars init` wrote on the previous run.
 * Returns an empty array when no manifest exists or the file is malformed.
 */
export const readInitManifest = (marsDir: string): string[] => {
  const manifestPath = resolve(marsDir, 'init-manifest.json')
  if (!existsSync(manifestPath)) return []
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as { paths?: unknown }
    if (!Array.isArray(parsed.paths)) return []
    return parsed.paths.filter((p): p is string => typeof p === 'string')
  } catch {
    return []
  }
}

/**
 * Write (or overwrite) the init manifest at `<marsDir>/init-manifest.json`
 * listing all CLAUDE.md paths that `mars init` wrote on this run.
 */
export const writeInitManifest = (
  marsDir: string,
  paths: string[],
  now: () => string = () => new Date().toISOString(),
): void => {
  mkdirSync(marsDir, { recursive: true })
  const manifest: InitManifest = {
    version: 1,
    generatedAt: now(),
    paths,
  }
  writeFileSync(
    resolve(marsDir, 'init-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )
}
