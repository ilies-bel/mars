import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the bundled `templates/` directory regardless of whether the
 * orchestrator is being run from source (`src/init/scaffold.ts`) or from a
 * compiled artefact (`dist/init/scaffold.js`). The `templates/` folder sits
 * alongside this file in both layouts because the build step copies it.
 */
const TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'templates',
)

const TEMPLATE_CLAUDE_MD = resolve(TEMPLATES_DIR, 'CLAUDE.md')

/**
 * Bundled template for the repo-root `.mcp.json` that registers the codegraph
 * MCP server. Delivered via the scaffold path (NOT via the `.claude/` bundle)
 * because `.mcp.json` lives at the repo root, not inside `.claude/`.
 */
const TEMPLATE_MCP_JSON = resolve(TEMPLATES_DIR, '.mcp.json')

export interface ScaffoldClaudeOptions {
  repoRoot: string
  force?: boolean
  dryRun?: boolean
}

export type ScaffoldClaudeResult =
  | { status: 'ok'; written: string[] }
  | { status: 'conflict'; conflicts: string[] }

interface PlannedCopy {
  /** Absolute source path inside the bundled templates tree. */
  src: string
  /** Absolute destination path under `repoRoot`. */
  dest: string
  /** Path relative to `repoRoot`, used for user-facing reporting. */
  rel: string
}

/**
 * Compute the full set of files `scaffoldClaudeConfig` would write into
 * `repoRoot`. Exported so `runInit` can pre-flight conflicts before the
 * workflow starts producing partial output.
 *
 * Note: the `.claude/` config tree (skills, agents, hooks, settings) is
 * intentionally NOT included here. Those files are delivered to consumers
 * via the Mars Claude Code plugin registered in ~/.claude/settings.json at
 * install time. Only the repository-bound `CLAUDE.md` is scaffolded.
 */
export const planClaudeCopies = (repoRoot: string): PlannedCopy[] => {
  const copies: PlannedCopy[] = []

  if (existsSync(TEMPLATE_CLAUDE_MD)) {
    const dest = resolve(repoRoot, 'CLAUDE.md')
    copies.push({ src: TEMPLATE_CLAUDE_MD, dest, rel: relative(repoRoot, dest) })
  }

  // .mcp.json: registers the codegraph MCP server so `codegraph_*` tools are
  // available to Claude Code sessions in the consumer repo. Collision policy:
  // if the target repo already has a .mcp.json, do NOT clobber it — the
  // `force` guard in `scaffoldClaudeConfig` (and the `existsSync` filter in
  // `planClaudeConflicts`) enforces this for every entry in this array.
  if (existsSync(TEMPLATE_MCP_JSON)) {
    const dest = resolve(repoRoot, '.mcp.json')
    copies.push({ src: TEMPLATE_MCP_JSON, dest, rel: relative(repoRoot, dest) })
  }

  return copies
}

/**
 * Inspect the planned scaffold and return the relative paths that already
 * exist under `repoRoot`. Used by `runInit` to aggregate conflicts across
 * multiple write paths into a single user-facing message.
 */
export const planClaudeConflicts = (repoRoot: string): string[] => {
  return planClaudeCopies(repoRoot)
    .filter((c) => existsSync(c.dest))
    .map((c) => c.rel)
}

/**
 * Copy the repository-bound Claude Code config (root `CLAUDE.md`) into
 * `opts.repoRoot`. Refuses to overwrite by default; pass `force: true` to
 * replace an existing file. `dryRun: true` returns the would-write set
 * without touching disk.
 *
 * The `.claude/` config tree (skills, agents, hooks, settings) is NOT copied
 * here — it is delivered to consumers via the Mars Claude Code plugin
 * registered in ~/.claude/settings.json at install time.
 */
export const scaffoldClaudeConfig = (
  opts: ScaffoldClaudeOptions,
): ScaffoldClaudeResult => {
  const { repoRoot, force = false, dryRun = false } = opts
  const copies = planClaudeCopies(repoRoot)

  if (!force) {
    const conflicts = copies
      .filter((c) => existsSync(c.dest))
      .map((c) => c.rel)
    if (conflicts.length > 0) {
      return { status: 'conflict', conflicts }
    }
  }

  const written: string[] = []
  for (const c of copies) {
    if (!dryRun) {
      mkdirSync(dirname(c.dest), { recursive: true })
      copyFileSync(c.src, c.dest)
    }
    written.push(c.rel)
  }

  return { status: 'ok', written }
}
