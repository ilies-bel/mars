import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WORKFLOWS_DEST_REL } from './scaffold-workflows'

export interface InitManifest {
  version: 1
  generatedAt: string
  /**
   * Relative paths (from repo root) of every file `mars init` wrote on the most
   * recent run — both the per-folder/root CLAUDE.md files and the scaffolded
   * `.mars/workflows/*.js` files. Used on the next run to distinguish
   * Mars-seeded files (safe to overwrite, or — for workflows — safe to offer a
   * diff for) from hand-written files (left alone).
   *
   * Workflow paths and CLAUDE.md paths share this one flat list; consumers that
   * need only the workflow paths use {@link readOwnedWorkflowPaths}, which is
   * backward-compatible: a v1 manifest written before workflow scaffolding
   * landed simply has no workflow entries, so every on-disk workflow is treated
   * as unowned (left untouched).
   */
  paths: string[]
}

/** Normalise a path to forward slashes so prefix matching is OS-independent. */
const toPosix = (p: string): string => p.split('\\').join('/')

/**
 * Read every path `mars init` wrote on the previous run (CLAUDE.md files +
 * scaffolded workflow files). Returns an empty array when no manifest exists or
 * the file is malformed.
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
 * Read only the manifest-owned workflow paths (those under
 * `.mars/workflows/`). Backward-compatible: a manifest with no workflow entries
 * (e.g. written before workflow scaffolding existed) returns `[]`, so callers
 * treat every on-disk workflow as unowned.
 */
export const readOwnedWorkflowPaths = (marsDir: string): string[] => {
  const prefix = `${toPosix(WORKFLOWS_DEST_REL)}/`
  return readInitManifest(marsDir).filter((p) => toPosix(p).startsWith(prefix))
}

/**
 * Write (or overwrite) the init manifest at `<marsDir>/init-manifest.json`
 * listing every path that `mars init` wrote on this run (CLAUDE.md +
 * `.mars/workflows/*.js`).
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
