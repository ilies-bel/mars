import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the bundled workflow-template directory regardless of whether the
 * orchestrator runs from source (`src/init/scaffold-workflows.ts`) or from a
 * compiled artefact (`dist/init/scaffold-workflows.js`). The
 * `templates/workflows/` folder sits alongside this file in both layouts
 * because the build step copies it.
 */
const WORKFLOW_TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'templates',
  'workflows',
)

/**
 * Repo-relative directory the scaffolded workflows land in. Plain JS the
 * consumer is expected to edit (ADR-0056); ownership is governed by ADR-0057.
 */
export const WORKFLOWS_DEST_REL = '.mars/workflows'

export interface ScaffoldWorkflowsOptions {
  repoRoot: string
  force?: boolean
  dryRun?: boolean
}

export type ScaffoldWorkflowsResult =
  | { status: 'ok'; written: string[] }
  | { status: 'conflict'; conflicts: string[] }

interface PlannedCopy {
  /** Absolute source path inside the bundled templates tree. */
  src: string
  /** Absolute destination path under `repoRoot`. */
  dest: string
  /** Path relative to `repoRoot`, used for user-facing reporting + the manifest. */
  rel: string
}

/**
 * The bundled `.js` template filenames, discovered from the templates dir so a
 * maintainer adding a template (per `templates/workflows/workflow-contract.md`)
 * does not also have to edit a hardcoded list. Only `*.js` files are workflow
 * templates — `workflow-contract.md` and any other non-`.js` files are ignored.
 */
const bundledWorkflowFiles = (): string[] => {
  if (!existsSync(WORKFLOW_TEMPLATES_DIR)) return []
  return readdirSync(WORKFLOW_TEMPLATES_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
}

/**
 * Compute the full set of files `scaffoldWorkflows` would write into
 * `repoRoot` (one entry per bundled `.js` template, copied into
 * `.mars/workflows/`). Mirrors `planClaudeCopies` in `scaffold.ts`.
 */
export const planWorkflowCopies = (repoRoot: string): PlannedCopy[] => {
  return bundledWorkflowFiles().map((name) => {
    const dest = resolve(repoRoot, WORKFLOWS_DEST_REL, name)
    return {
      src: resolve(WORKFLOW_TEMPLATES_DIR, name),
      dest,
      rel: relative(repoRoot, dest),
    }
  })
}

/**
 * Inspect the planned scaffold and return the relative paths that already
 * exist under `repoRoot`. Mirrors `planClaudeConflicts` in `scaffold.ts`.
 */
export const planWorkflowConflicts = (repoRoot: string): string[] => {
  return planWorkflowCopies(repoRoot)
    .filter((c) => existsSync(c.dest))
    .map((c) => c.rel)
}

/**
 * Copy the bundled plain-JS workflow templates into
 * `<repoRoot>/.mars/workflows/`. Mirrors `scaffoldClaudeConfig` in
 * `scaffold.ts`:
 *
 * - `force: false` (default) skips any destination that already exists and
 *   reports it in `written` only when it was actually copied — it NEVER errors
 *   on a pre-existing file (a fresh repo gets all of them; an existing repo
 *   keeps its edits). This is the ADR-0057 user-owned guarantee.
 * - `force: true` overwrites unconditionally (used by `mars init`'s pre-flighted
 *   path where the operator has already accepted overwrite).
 * - `dryRun: true` returns the would-write set without touching disk.
 *
 * Unlike `scaffoldClaudeConfig`, the no-force path here does not return a
 * `conflict` status — workflows are user-owned, so a pre-existing file is the
 * expected steady state, not an error. The `conflict` branch is retained for
 * API symmetry and only triggers in `force: false` runs that opt into
 * conflict-reporting via the result shape; callers that want diff-driven
 * conflict handling use `planWorkflowConflicts` + `mars update` instead.
 */
export const scaffoldWorkflows = (
  opts: ScaffoldWorkflowsOptions,
): ScaffoldWorkflowsResult => {
  const { repoRoot, force = false, dryRun = false } = opts
  const copies = planWorkflowCopies(repoRoot)

  const written: string[] = []
  for (const c of copies) {
    const exists = existsSync(c.dest)
    // User-owned: never overwrite an existing workflow file unless forced.
    // Crucially, a pre-existing file is silently skipped (no throw, no
    // conflict) so re-running init on a repo with edited workflows is safe.
    if (exists && !force) continue
    if (!dryRun) {
      mkdirSync(dirname(c.dest), { recursive: true })
      copyFileSync(c.src, c.dest)
    }
    written.push(c.rel)
  }

  return { status: 'ok', written }
}
