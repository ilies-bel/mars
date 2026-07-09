import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const TEMPLATE_GITIGNORE = resolve(TEMPLATES_DIR, '.gitignore')

/**
 * Bundled template for the repo-root `.mcp.json` that registers the codegraph
 * MCP server. Delivered via the scaffold path (NOT via the `.claude/` bundle)
 * because `.mcp.json` lives at the repo root, not inside `.claude/`.
 *
 * Note: `templates/mcp.json` (no leading dot) is the source-level documentation
 * copy that includes a `_comment` explaining the interactive-vs-worker config
 * divergence. That comment is framework-internal and MUST NOT be delivered to
 * consumers. `templates/.mcp.json` is the clean consumer-facing template.
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

/**
 * Merge the codegraph MCP server entry into `<repoRoot>/.mcp.json`.
 *
 * - If the consumer has no `.mcp.json`, write the bundled template verbatim.
 * - If the consumer already has a `.mcp.json`, parse it, add/overwrite ONLY the
 *   `mcpServers.codegraph` key, and preserve every other server and top-level key.
 * - If the consumer's `.mcp.json` is malformed JSON, throw with a clear message.
 * - Idempotent: a second call with the same state produces no diff
 *   (stable key ordering, 2-space indent, trailing newline).
 */
export const mergeMcpJson = (repoRoot: string): void => {
  const destPath = resolve(repoRoot, '.mcp.json')
  const template = JSON.parse(readFileSync(TEMPLATE_MCP_JSON, 'utf8')) as {
    mcpServers: Record<string, unknown>
  }
  const codegraphEntry = template.mcpServers['codegraph']

  if (!existsSync(destPath)) {
    writeFileSync(destPath, JSON.stringify(template, null, 2) + '\n')
  } else {
    let existing: Record<string, unknown>
    try {
      existing = JSON.parse(readFileSync(destPath, 'utf8')) as Record<string, unknown>
    } catch (err) {
      throw new Error(
        `.mcp.json at ${destPath} is malformed JSON and cannot be merged: ${(err as Error).message}`,
      )
    }

    const existingServers =
      typeof existing['mcpServers'] === 'object' && existing['mcpServers'] !== null
        ? (existing['mcpServers'] as Record<string, unknown>)
        : {}

    const merged: Record<string, unknown> = {
      ...existing,
      mcpServers: {
        ...existingServers,
        codegraph: codegraphEntry,
      },
    }

    writeFileSync(destPath, JSON.stringify(merged, null, 2) + '\n')
  }

  // Non-fatal PATH probe: advise the user if codegraph is absent so they
  // know why graph tools are inert (ADR-0062 — codegraph is a soft dep).
  // Runs on both fresh-write and merge paths. Swallow any spawn errors so
  // the probe itself never breaks init.
  try {
    const probe = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['codegraph'],
      { encoding: 'utf8', shell: false },
    )
    if (!probe.error && probe.status !== 0) {
      process.stderr.write(
        '[mars init] codegraph not found on PATH — graph tools will be inert until you install it (npm i -g codegraph && codegraph index). See ADR-0062.\n',
      )
    }
  } catch {
    // Swallow — never let the PATH probe break init
  }
}

/**
 * Merge the bundled JVM crash-dump .gitignore block into `existing` content.
 *
 * The block is appended only when NEITHER `hs_err_pid*.log` NOR
 * `replay_pid*.log` is already present. This keeps the operation idempotent
 * and safe for repos that already added the rules manually (such as
 * projet-elissa, which got them in commit 12c3d38). Existing repos are never
 * touched unless they opt in by calling this function.
 *
 * Returns the (possibly modified) string — callers decide whether to write it.
 */
export const mergeGitignore = (existing: string): string => {
  if (
    existing.includes('hs_err_pid*.log') ||
    existing.includes('replay_pid*.log')
  ) {
    return existing
  }
  const block = readFileSync(TEMPLATE_GITIGNORE, 'utf8')
  // Ensure a blank-line separator between existing content and the new block.
  const trimmed = existing.trimEnd()
  const separator = trimmed.length === 0 ? '' : '\n\n'
  return trimmed + separator + block
}

/**
 * Read `<repoRoot>/.gitignore` (creating it if absent), merge the JVM
 * crash-dump block, and write the result back. Idempotent on subsequent calls.
 */
export const applyGitignoreScaffold = (repoRoot: string): void => {
  const destPath = resolve(repoRoot, '.gitignore')
  const existing = existsSync(destPath) ? readFileSync(destPath, 'utf8') : ''
  const merged = mergeGitignore(existing)
  if (merged !== existing) {
    writeFileSync(destPath, merged)
  }
}
