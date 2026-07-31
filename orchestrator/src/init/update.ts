/**
 * `mars update` — re-run init in update-mode without clobbering user-owned files.
 *
 * The novel behaviour over `mars init --force` lives here: scaffolded workflow
 * files in `.mars/workflows/` are USER-OWNED (ADR-0057). `mars update` never
 * silently overwrites them. For each manifest-owned workflow whose on-disk copy
 * has diverged from the bundled template it shows a unified diff and prompts
 * accept/skip; identical files are silently refreshed; files the user has
 * removed from the manifest (unowned) are left completely untouched.
 *
 * The logic is split so it is testable without spawning a process: callers
 * inject a {@link LineReader} (the same seam the init wizard uses) and `out`,
 * and the function returns a structured {@link UpdateWorkflowsResult}.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { planWorkflowCopies } from './scaffold-workflows'
import { readInitManifest, readOwnedWorkflowPaths, writeInitManifest } from './init-manifest'
import { unifiedDiff } from './unified-diff'

/** Async line reader; production wraps Node's readline, tests inject a fake. */
export type LineReader = (question: string) => Promise<string>

export type WorkflowUpdateOutcome =
  | 'created' // file did not exist — scaffolded fresh
  | 'unchanged' // on-disk identical to template — silently refreshed (no-op)
  | 'accepted' // diverged + user accepted the new template
  | 'skipped' // diverged + user (or --yes) declined; on-disk kept
  | 'untouched' // diverged but unowned (removed from manifest) — left alone

export interface WorkflowUpdateRecord {
  /** Repo-relative destination path, e.g. `.mars/workflows/task-workflow.js`. */
  rel: string
  outcome: WorkflowUpdateOutcome
}

export interface UpdateWorkflowsResult {
  records: WorkflowUpdateRecord[]
  /** Operator-facing tally derived from the reconciliation records. */
  summary: {
    created: number
    updated: number
    kept: number
    unowned: number
  }
}

export interface UpdateWorkflowsOptions {
  repoRoot: string
  stateDir: string
  /**
   * Non-interactive (CI) mode: never prompt. Diverged owned files default to
   * skip-on-conflict (the safe choice — never lose the user's edits).
   */
  yes: boolean
  /**
   * Non-interactive mode that APPLIES the new template to every diverged owned
   * file, overwriting the user's local edits. Mutually independent from `yes`,
   * which is skip-on-conflict. If BOTH are somehow passed, `acceptAll` wins
   * (accept beats skip) — but the CLI guards against that combination.
   */
  acceptAll: boolean
  /** Prompt seam. Only called for diverged owned files when `yes` is false and `acceptAll` is false. */
  readLine: LineReader
  /** Output sink. */
  out: (s: string) => void
}

const isAccept = (answer: string): boolean => {
  const a = answer.trim().toLowerCase()
  return a === 'y' || a === 'yes'
}

/**
 * Reconcile every bundled workflow template against the consumer's
 * `.mars/workflows/` tree, honouring ADR-0057 ownership. Returns one record per
 * bundled template and refreshes the init manifest to include every workflow
 * file that now exists and is owned (created or accepted).
 */
export const updateWorkflows = async (
  opts: UpdateWorkflowsOptions,
): Promise<UpdateWorkflowsResult> => {
  const { repoRoot, stateDir, yes, acceptAll, readLine, out } = opts
  const copies = planWorkflowCopies(repoRoot)
  const ownedSet = new Set(readOwnedWorkflowPaths(stateDir))

  const records: WorkflowUpdateRecord[] = []
  const newlyOwned: string[] = []

  for (const c of copies) {
    const template = readFileSync(c.src, 'utf8')

    if (!existsSync(c.dest)) {
      // Fresh scaffold — nothing to protect.
      mkdirSync(dirname(c.dest), { recursive: true })
      copyFileSync(c.src, c.dest)
      records.push({ rel: c.rel, outcome: 'created' })
      newlyOwned.push(c.rel)
      continue
    }

    const onDisk = readFileSync(c.dest, 'utf8')
    if (onDisk === template) {
      // Byte-identical — silently re-scaffold (idempotent no-op write).
      copyFileSync(c.src, c.dest)
      records.push({ rel: c.rel, outcome: 'unchanged' })
      // Identical-but-present files are owned regardless of manifest history.
      newlyOwned.push(c.rel)
      continue
    }

    // Diverged. A file the user removed from the manifest is unowned — leave it.
    if (!ownedSet.has(c.rel)) {
      out(`[mars update] ${c.rel}: hand-edited and unowned — left untouched`)
      records.push({ rel: c.rel, outcome: 'untouched' })
      continue
    }

    // Diverged + owned — show the diff and (unless --accept-all/--yes) prompt.
    out(`[mars update] ${c.rel} has changed in this release:`)
    out(unifiedDiff(onDisk, template, c.rel))

    // acceptAll wins over yes (accept beats skip — but CLI guards the combo).
    if (acceptAll) {
      copyFileSync(c.src, c.dest)
      out(`[mars update] ${c.rel}: --accept-all set — applied new template`)
      records.push({ rel: c.rel, outcome: 'accepted' })
      newlyOwned.push(c.rel)
      continue
    }

    if (yes) {
      out(`[mars update] ${c.rel}: --yes set — keeping your version (skip)`)
      records.push({ rel: c.rel, outcome: 'skipped' })
      newlyOwned.push(c.rel)
      continue
    }

    const answer = await readLine(
      `Apply the new template for ${c.rel}? [y/N] `,
    )
    if (isAccept(answer)) {
      copyFileSync(c.src, c.dest)
      out(`[mars update] ${c.rel}: applied new template`)
      records.push({ rel: c.rel, outcome: 'accepted' })
      newlyOwned.push(c.rel)
    } else {
      out(`[mars update] ${c.rel}: kept your version (skip)`)
      records.push({ rel: c.rel, outcome: 'skipped' })
      newlyOwned.push(c.rel)
    }
  }

  // Refresh the manifest: union the existing entries with every workflow file
  // that now exists and is owned, so subsequent updates still recognise them.
  if (newlyOwned.length > 0) {
    const existing = readInitManifest(stateDir)
    const merged = Array.from(new Set([...existing, ...newlyOwned]))
    // Only write when the set actually grew (avoid pointless churn).
    if (merged.length !== existing.length) {
      writeInitManifest(stateDir, merged)
    }
  }

  return {
    records,
    summary: records.reduce(
      (summary, record) => {
        if (record.outcome === 'created') summary.created += 1
        if (record.outcome === 'accepted') summary.updated += 1
        if (record.outcome === 'skipped') summary.kept += 1
        if (record.outcome === 'untouched') summary.unowned += 1
        return summary
      },
      { created: 0, updated: 0, kept: 0, unowned: 0 },
    ),
  }
}

/** Production readline-backed {@link LineReader}. */
export const realLineReader: LineReader = async (question) => {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await new Promise<string>((res) => rl.question(question, res))
  } finally {
    rl.close()
  }
}

/** Resolve a repo-relative workflow dest to its absolute path (helper for tests). */
export const workflowDestPath = (repoRoot: string, rel: string): string =>
  resolve(repoRoot, rel)
