/**
 * `workflow` command group: `list` and `show` — read-only views of the
 * workflow kinds registered in this repo.
 *
 * Both commands are pure filesystem + DB reads — no daemon socket round-trip.
 *
 * Sources (ADR-0056 / ADR-0057):
 *   - "bundled"       — kind has a bundled template, no on-disk file.
 *   - "scaffolded"    — file exists on disk, content matches the bundled template.
 *   - "user-modified" — file exists on disk but differs from the bundled template.
 *   - "custom"        — file exists on disk, no bundled counterpart for that kind.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname as _dirname } from 'node:path'
import type { Command } from '../command'
import { PRIMITIVE_DESCRIPTORS } from '../../workflows/primitives/opts-descriptors'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Derive the workflow `kind` from a filename like `task-workflow.js`. */
const kindFromFilename = (filename: string): string =>
  filename.replace(/-workflow\.js$/, '')

/** Absolute path to the bundled workflow templates directory. */
const bundledTemplatesDir = (): string =>
  resolve(
    _dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'init',
    'templates',
    'workflows',
  )

/** Map of kind → absolute bundled template path, for all bundled `.js` templates. */
const bundledKinds = (): Map<string, string> => {
  const dir = bundledTemplatesDir()
  const result = new Map<string, string>()
  if (!existsSync(dir)) return result
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.js')) continue
    result.set(kindFromFilename(name), resolve(dir, name))
  }
  return result
}

/** Absolute path to the user's `.mars/workflows/` directory. */
const userWorkflowsDir = (stateDir: string): string =>
  resolve(stateDir, 'workflows')

/** All `.js` filenames found under `.mars/workflows/`. */
const userWorkflowFiles = (stateDir: string): string[] => {
  const dir = userWorkflowsDir(stateDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.js'))
}

type WorkflowSource = 'bundled' | 'scaffolded' | 'user-modified' | 'custom'

interface WorkflowEntry {
  kind: string
  source: WorkflowSource
  /** Absolute path to the active file, or null when the bundled fallback is used. */
  filePath: string | null
}

/**
 * Build the full list of workflow entries visible in this repo. Combines
 * bundled kinds with on-disk files; classifies each by its source.
 */
const resolveWorkflowEntries = (stateDir: string): WorkflowEntry[] => {
  const bundled = bundledKinds()
  const userFiles = userWorkflowFiles(stateDir)

  const seen = new Set<string>()
  const entries: WorkflowEntry[] = []

  // On-disk files first — they take precedence over bundled fallbacks.
  for (const filename of userFiles) {
    const kind = kindFromFilename(filename)
    seen.add(kind)
    const diskPath = resolve(userWorkflowsDir(stateDir), filename)
    const bundledPath = bundled.get(kind)

    let source: WorkflowSource
    if (bundledPath === undefined) {
      // No bundled counterpart — purely user-created.
      source = 'custom'
    } else {
      // Compare bytes: pristine scaffold vs. user-edited.
      const diskContent = readFileSync(diskPath, 'utf8')
      const templateContent = readFileSync(bundledPath, 'utf8')
      source = diskContent === templateContent ? 'scaffolded' : 'user-modified'
    }

    entries.push({ kind, source, filePath: diskPath })
  }

  // Bundled kinds with no on-disk file → "bundled" (fallback active).
  for (const [kind, _templatePath] of bundled) {
    if (!seen.has(kind)) {
      entries.push({ kind, source: 'bundled', filePath: null })
    }
  }

  return entries.sort((a, b) => a.kind.localeCompare(b.kind))
}

/**
 * Query the most recent run timestamp for each kind from the `workflow_runs`
 * table. Returns a Map of kind → ISO-8601 string (or null when no runs exist).
 *
 * workflow_runs.workflow_id holds the kind string (e.g. 'task', 'fix').
 */
const queryLastRunTimestamps = async (
  store: Parameters<Command['run']>[1]['store'],
  kinds: string[],
): Promise<Map<string, string>> => {
  if (kinds.length === 0) return new Map()
  try {
    const rows = await store.query(
      `SELECT workflow_id, MAX(updated_at) AS last_updated
       FROM workflow_runs
       WHERE workflow_id IN (${kinds.map(() => '?').join(', ')})
       GROUP BY workflow_id`,
      kinds,
    )
    const result = new Map<string, string>()
    for (const row of rows.rows) {
      const wid = row[0] as string
      const ts = row[1] as number | null
      if (ts !== null) {
        result.set(wid, new Date(ts).toISOString())
      }
    }
    return result
  } catch {
    // workflow_runs table may not exist in older DBs — degrade gracefully.
    return new Map()
  }
}

/**
 * Fetch the step names from the most recent run of a given kind, ordered by
 * `seq`. Returns null when no runs exist.
 */
const queryLastRunSteps = async (
  store: Parameters<Command['run']>[1]['store'],
  kind: string,
): Promise<{ steps: string[]; status: string } | null> => {
  try {
    // Find the most recent run for this kind.
    const runRows = await store.query(
      `SELECT id, status FROM workflow_runs
       WHERE workflow_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
      [kind],
    )
    if (runRows.rows.length === 0) return null
    const runId = runRows.rows[0]?.[0] as string
    const runStatus = runRows.rows[0]?.[1] as string

    // Fetch step names for that run, in insertion order.
    const stepRows = await store.query(
      `SELECT step_name FROM workflow_step_runs
       WHERE run_id = ?
       ORDER BY seq ASC`,
      [runId],
    )
    const steps = stepRows.rows.map((r) => r[0] as string)
    return { steps, status: runStatus }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const workflowList: Command = {
  path: 'workflow list',
  summary: 'list workflow kinds with their active source (local read)',
  usage: 'usage: mars workflow list',
  run: async (_args, deps) => {
    const entries = resolveWorkflowEntries(deps.ctx.stateDir)
    const kinds = entries.map((e) => e.kind)
    const lastRuns = await queryLastRunTimestamps(deps.store, kinds)

    if (entries.length === 0) {
      deps.out('(no workflows — run `mars init` to scaffold defaults)')
      return { code: 0 }
    }

    const kindW = Math.max(...entries.map((e) => e.kind.length), 4)
    const srcW = Math.max(...entries.map((e) => e.source.length), 6)

    const header = `${'KIND'.padEnd(kindW)}  ${'SOURCE'.padEnd(srcW)}  ${'FILE'.padEnd(30)}  LAST RUN`
    deps.out(header)
    deps.out('-'.repeat(header.length + 10))

    for (const entry of entries) {
      const fileDisplay = entry.filePath ?? '(bundled)'
      const lastRun = lastRuns.get(entry.kind) ?? '—'
      deps.out(
        `${entry.kind.padEnd(kindW)}  ${entry.source.padEnd(srcW)}  ${fileDisplay.padEnd(30)}  ${lastRun}`,
      )
    }
    return { code: 0 }
  },
}

const workflowShow: Command = {
  path: 'workflow show',
  summary: 'show details for a workflow kind — active file, last steps, parameter surface (local read)',
  usage: 'usage: mars workflow show <kind>',
  run: async (args, deps) => {
    const kind = args.positional[0]
    if (!kind) {
      deps.err('usage: mars workflow show <kind>')
      return { code: 1 }
    }

    const entries = resolveWorkflowEntries(deps.ctx.stateDir)
    const entry = entries.find((e) => e.kind === kind)

    if (entry === undefined) {
      deps.err(
        `no workflow found for kind "${kind}" — run \`mars workflow list\` to see available kinds`,
      )
      return { code: 1 }
    }

    // ── Active file ────────────────────────────────────────────────────────
    deps.out(`kind:    ${entry.kind}`)
    deps.out(`source:  ${entry.source}`)
    deps.out(`file:    ${entry.filePath ?? '(bundled fallback)'}`)
    deps.out('')

    // ── Last run steps ─────────────────────────────────────────────────────
    const runInfo = await queryLastRunSteps(deps.store, kind)
    if (runInfo === null) {
      deps.out('last run: (no runs recorded)')
    } else {
      deps.out(`last run: status=${runInfo.status}`)
      if (runInfo.steps.length === 0) {
        deps.out('  (no steps recorded)')
      } else {
        for (const step of runInfo.steps) {
          deps.out(`  • ${step}`)
        }
      }
    }
    deps.out('')

    // ── Parameter surface ──────────────────────────────────────────────────
    deps.out('primitives and override options:')
    for (const { name, descriptors } of PRIMITIVE_DESCRIPTORS) {
      deps.out(`  ${name}(ctx, opts)`)
      for (const [opt, description] of Object.entries(descriptors)) {
        deps.out(`    ${opt}: ${description}`)
      }
    }

    return { code: 0 }
  },
}

const workflowGroup: Command = {
  path: 'workflow',
  summary: 'workflow subcommands',
  usage: 'usage: mars workflow <list|show> ...',
  run: (_args, deps) => {
    deps.err('usage: mars workflow <list|show> ...')
    return { code: 1 }
  },
}

export const workflowCommands: readonly Command[] = [
  workflowList,
  workflowShow,
  workflowGroup,
]
