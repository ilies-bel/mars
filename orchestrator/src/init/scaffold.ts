import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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

const TEMPLATE_CLAUDE_DIR = resolve(TEMPLATES_DIR, 'claude')
const TEMPLATE_CLAUDE_MD = resolve(TEMPLATES_DIR, 'CLAUDE.md')

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

const walkFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/**
 * Compute the full set of files `scaffoldClaudeConfig` would write into
 * `repoRoot`. Exported so `runInit` can pre-flight conflicts before the
 * workflow starts producing partial output.
 */
export const planClaudeCopies = (repoRoot: string): PlannedCopy[] => {
  const copies: PlannedCopy[] = []

  if (existsSync(TEMPLATE_CLAUDE_DIR)) {
    for (const src of walkFiles(TEMPLATE_CLAUDE_DIR)) {
      const relToClaude = relative(TEMPLATE_CLAUDE_DIR, src)
      const dest = resolve(repoRoot, '.claude', relToClaude)
      copies.push({
        src,
        dest,
        rel: relative(repoRoot, dest),
      })
    }
  }

  if (existsSync(TEMPLATE_CLAUDE_MD)) {
    const dest = resolve(repoRoot, 'CLAUDE.md')
    copies.push({
      src: TEMPLATE_CLAUDE_MD,
      dest,
      rel: relative(repoRoot, dest),
    })
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

const HOOKS_PREFIX = '.claude/hooks/'

const isHookFile = (relPath: string): boolean =>
  relPath.startsWith(HOOKS_PREFIX) || relPath.startsWith('.claude\\hooks\\')

const sourceMode = (src: string): number => {
  try {
    return statSync(src).mode & 0o777
  } catch {
    return 0o644
  }
}

const targetMode = (rel: string, src: string): number => {
  if (isHookFile(rel)) return 0o755
  return sourceMode(src)
}

/**
 * Copy the bundled Claude Code config (`.claude/**` + root `CLAUDE.md`) into
 * `opts.repoRoot`. Refuses to overwrite by default; pass `force: true` to
 * replace existing files. `dryRun: true` returns the would-write set without
 * touching disk.
 *
 * Files under `.claude/hooks/` are always written with mode `0755` so the
 * `mars init` smoke test can immediately exec the hook scripts even on
 * filesystems that drop the executable bit on copy (e.g. npm tarballs).
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
      try {
        chmodSync(c.dest, targetMode(c.rel, c.src))
      } catch {
        // best-effort: chmod may fail on exotic filesystems; the file is
        // still copied, which is what matters for the conflict check
      }
    }
    written.push(c.rel)
  }

  return { status: 'ok', written }
}
