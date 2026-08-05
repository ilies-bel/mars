/**
 * `workflow` command group: `list`, `show`, `validate`, `render` — read-only
 * views of the workflow kinds registered in this repo — plus the
 * self-authored-workflow write path `author` / `approve` (ADR-0068).
 *
 * The read commands are pure filesystem + DB reads — no daemon socket
 * round-trip. `author` writes a new draft file + raises an action-queue row;
 * `approve` rewrites the provenance header + supersedes the row.
 *
 * Sources (ADR-0056 / ADR-0057 / ADR-0068):
 *   - "bundled"       — kind has a bundled template, no on-disk file.
 *   - "scaffolded"    — file exists on disk, content matches the bundled template.
 *   - "user-modified" — file exists on disk but differs from the bundled template.
 *   - "custom"        — file exists on disk, no bundled counterpart for that kind.
 *   - "agent-draft"   — file carries the pending-approval marker written by
 *                       `mars workflow author`; NOT dispatch-eligible until
 *                       `mars workflow approve <name>`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { hasFlag } from '../args'
import type { Command } from '../command'
import { PRIMITIVE_DESCRIPTORS } from '../../workflows/primitives/opts-descriptors'
import { planWorkflowCopies } from '../../init/scaffold-workflows'
import {
  readWorkflowProvenance,
  stampAgentDraft,
  approveDraftSource,
  WORKFLOW_DRAFT_ACTION_QUEUE_KIND,
} from '../../workflows/agent-draft'
import { lintAgentWorkflowBody } from '../../workflows/workflow-lint'
import type { DeclaredStep } from '../../workflows/validate-workflow'
import { errorMessage } from './shared'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Derive the workflow `kind` from a filename like `task-workflow.js`. */
const kindFromFilename = (filename: string): string =>
  filename.replace(/-workflow\.js$/, '')

/** Map of kind → absolute bundled template path, for all bundled `.js` templates. */
const bundledKinds = (repoRoot: string): Map<string, string> =>
  new Map(
    planWorkflowCopies(repoRoot).map((workflow) => [
      kindFromFilename(basename(workflow.src)),
      workflow.src,
    ]),
  )

/** Absolute path to the user's `.mars/workflows/` directory. */
const userWorkflowsDir = (stateDir: string): string =>
  resolve(stateDir, 'workflows')

/** All `.js` filenames found under `.mars/workflows/`. */
const userWorkflowFiles = (stateDir: string): string[] => {
  const dir = userWorkflowsDir(stateDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith('.js'))
}

// 'missing' = a bundled template exists but no on-disk file does. There is NO
// dispatch fallback (ADR-0067): a task routed to a missing workflow fails, so
// the honest remedy is scaffolding the file (`mars update`).
// 'agent-draft' = a self-authored file pending operator approval (ADR-0068);
// dispatch for this name hard-fails until `mars workflow approve <name>`.
type WorkflowSource = 'missing' | 'scaffolded' | 'user-modified' | 'custom' | 'agent-draft'

/** Human-facing label for a source — drafts carry their gating state inline. */
const sourceLabel = (source: WorkflowSource): string =>
  source === 'agent-draft' ? 'agent-draft (pending approval)' : source

interface WorkflowEntry {
  kind: string
  source: WorkflowSource
  /** Absolute path to the active file, or null when no file is on disk. */
  filePath: string | null
}

/**
 * Build the full list of workflow entries visible in this repo. Combines
 * bundled kinds with on-disk files; classifies each by its source.
 */
const resolveWorkflowEntries = (repoRoot: string, stateDir: string): WorkflowEntry[] => {
  const bundled = bundledKinds(repoRoot)
  const userFiles = userWorkflowFiles(stateDir)

  const seen = new Set<string>()
  const entries: WorkflowEntry[] = []

  // On-disk files first — they take precedence over bundled fallbacks.
  for (const filename of userFiles) {
    const kind = kindFromFilename(filename)
    seen.add(kind)
    const diskPath = resolve(userWorkflowsDir(stateDir), filename)
    const bundledPath = bundled.get(kind)
    const diskContent = readFileSync(diskPath, 'utf8')

    let source: WorkflowSource
    if (readWorkflowProvenance(diskContent).pendingApproval) {
      // Self-authored draft awaiting operator approval (ADR-0068). Checked
      // first: a draft is never dispatch-eligible regardless of its bytes.
      source = 'agent-draft'
    } else if (bundledPath === undefined) {
      // No bundled counterpart — purely user-created (an approved
      // self-authored workflow also classifies here, with its author
      // marker preserved for audit).
      source = 'custom'
    } else {
      // Compare bytes: pristine scaffold vs. user-edited.
      const templateContent = readFileSync(bundledPath, 'utf8')
      source = diskContent === templateContent ? 'scaffolded' : 'user-modified'
    }

    entries.push({ kind, source, filePath: diskPath })
  }

  // Bundled kinds with no on-disk file → 'missing': dispatch for this name
  // hard-fails until the file is scaffolded.
  for (const [kind, _templatePath] of bundled) {
    if (!seen.has(kind)) {
      entries.push({ kind, source: 'missing', filePath: null })
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
    const entries = resolveWorkflowEntries(deps.ctx.repoRoot, deps.ctx.stateDir)
    const kinds = entries.map((e) => e.kind)
    const lastRuns = await queryLastRunTimestamps(deps.store, kinds)

    if (entries.length === 0) {
      deps.out('(no workflows — run `mars init` to scaffold defaults)')
      return { code: 0 }
    }

    const kindW = Math.max(...entries.map((e) => e.kind.length), 4)
    const srcW = Math.max(...entries.map((e) => sourceLabel(e.source).length), 6)

    const header = `${'KIND'.padEnd(kindW)}  ${'SOURCE'.padEnd(srcW)}  ${'FILE'.padEnd(30)}  LAST RUN`
    deps.out(header)
    deps.out('-'.repeat(header.length + 10))

    for (const entry of entries) {
      const fileDisplay = entry.filePath ?? '(none — run `mars update` to scaffold)'
      const lastRun = lastRuns.get(entry.kind) ?? '—'
      deps.out(
        `${entry.kind.padEnd(kindW)}  ${sourceLabel(entry.source).padEnd(srcW)}  ${fileDisplay.padEnd(30)}  ${lastRun}`,
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

    const entries = resolveWorkflowEntries(deps.ctx.repoRoot, deps.ctx.stateDir)
    const entry = entries.find((e) => e.kind === kind)

    if (entry === undefined) {
      deps.err(
        `no workflow found for kind "${kind}" — run \`mars workflow list\` to see available kinds`,
      )
      return { code: 1 }
    }

    // ── Active file ────────────────────────────────────────────────────────
    deps.out(`kind:    ${entry.kind}`)
    deps.out(`source:  ${sourceLabel(entry.source)}`)
    deps.out(
      `file:    ${entry.filePath ?? '(none — dispatch for this name fails until scaffolded; run `mars update`)'}`,
    )
    if (entry.filePath !== null) {
      // Self-authored provenance survives approval — show the author for audit.
      const provenance = readWorkflowProvenance(readFileSync(entry.filePath, 'utf8'))
      if (provenance.author !== null) {
        deps.out(`author:  ${provenance.author} (self-authored)`)
      }
    }
    deps.out('')

    // ── Declared runbook (validation dry-run; best-effort) ────────────────
    if (entry.filePath !== null) {
      try {
        const { validateWorkflow } = await import(
          '../../workflows/validate-workflow'
        )
        const v = await validateWorkflow(kind)
        deps.out('declared pipeline:')
        if (v.ok) {
          for (const [i, s] of v.steps.entries()) {
            const modeLabel = s.mode === 'manual' ? 'MANUAL' : 'auto'
            const guide = s.guide ? ` — guide: ${s.guide}` : ''
            deps.out(
              `  ${i + 1}. ${s.step ?? '(outside a step)'}  ${s.primitive}  [${modeLabel}]${guide}`,
            )
          }
        } else {
          for (const e of v.errors) deps.out(`  INVALID: ${e}`)
        }
        deps.out('')
      } catch {
        // Best-effort: show still renders the rest.
      }
    }

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

/** Minimal shape guard shared with `loadWorkflowByName`. */
const isWorkflowShape = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) return false
  const c = v as { id?: unknown; fn?: unknown }
  return typeof c.id === 'string' && typeof c.fn === 'function'
}

const workflowValidate: Command = {
  path: 'workflow validate',
  summary:
    'sanity-check a workflow file — print ok: <path> or the exact loader error that dispatch would raise',
  usage: 'usage: mars workflow validate <kind>  [--file <path>]',
  run: async (args, deps) => {
    const {
      loadWorkflowByName,
      isWorkflowLoadError,
      userWorkflowPath,
    } = await import('../../workflows/queue-workflow-store')

    const explicitFile = args.flags['--file']
    const kind = args.positional[0]

    if (!explicitFile && !kind) {
      deps.err('usage: mars workflow validate <kind>  [--file <path>]')
      return { code: 1 }
    }

    if (explicitFile) {
      // --file: validate an arbitrary path, skipping kind-based path derivation.
      if (!existsSync(explicitFile)) {
        deps.err(
          `no workflow file at '${explicitFile}': path does not exist. No fallback pipeline is ever substituted.`,
        )
        return { code: 1 }
      }

      const mtimeMs = statSync(explicitFile).mtimeMs
      let candidate: unknown
      try {
        const mod = (await import(
          `${pathToFileURL(explicitFile).href}?v=${mtimeMs}`
        )) as { default?: unknown }
        candidate = mod.default
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        deps.err(`workflow file ${explicitFile} failed to load: ${msg}`)
        return { code: 1 }
      }

      if (!isWorkflowShape(candidate)) {
        deps.err(
          `workflow file ${explicitFile} must default-export a workflow object with { id: string, fn: function } (use defineWorkflow from 'mars/workflow'). No fallback pipeline is substituted — fix the export.`,
        )
        return { code: 1 }
      }

      deps.out(`ok: ${explicitFile}`)
      return { code: 0 }
    }

    // kind-based path — delegate to the same loader dispatch uses.
    const resolvedPath = userWorkflowPath(kind!, deps.ctx.repoRoot)
    try {
      await loadWorkflowByName(kind!, deps.ctx.repoRoot)
      deps.out(`ok: ${resolvedPath}`)
      return { code: 0 }
    } catch (err) {
      if (isWorkflowLoadError(err)) {
        deps.err(err.message)
        return { code: 1 }
      }
      throw err
    }
  },
}

const workflowRender: Command = {
  path: 'workflow render',
  summary: 'print the workflow runbook — steps in order with mode and guide (local read)',
  usage: 'usage: mars workflow render <kind>  [--json]',
  run: async (args, deps) => {
    const jsonFlag = hasFlag(args, '--json')
    const kind = args.positional[0]

    if (!kind) {
      deps.err('usage: mars workflow render <kind>  [--json]')
      return { code: 1 }
    }

    const { validateWorkflow } = await import('../../workflows/validate-workflow')
    const v = await validateWorkflow(kind, deps.ctx.repoRoot)

    if (!v.ok) {
      for (const e of v.errors) deps.err(e)
      return { code: 1 }
    }

    if (jsonFlag) {
      const steps = v.steps.map((s) => {
        const entry: { name: string; mode: string; guide?: string } = {
          name: s.step ?? '(outside a step)',
          mode: s.mode,
        }
        if (s.guide !== null) entry.guide = s.guide
        return entry
      })
      deps.out(JSON.stringify({ kind, steps }))
      return { code: 0 }
    }

    // Text output: numbered steps with mode label; guide on the next line for
    // manual steps.
    for (const [i, s] of v.steps.entries()) {
      deps.out(`${i + 1}. ${s.step ?? '(outside a step)'}  [${s.mode}]`)
      if (s.guide !== null) {
        deps.out(`   guide: ${s.guide}`)
      }
    }
    return { code: 0 }
  },
}

// ---------------------------------------------------------------------------
// Self-authored workflows (ADR-0068): author → lint → dry-run → agent-draft →
// operator approve. The trust boundary is write-time approval, not a runtime
// sandbox — see docs/knowledge/decisions/0068-self-authored-workflows-are-approval-gated-at-write-time-not.md.
// ---------------------------------------------------------------------------

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Text rendering of a declared runbook — same shape `workflow render` prints. */
const renderRunbookLines = (steps: readonly DeclaredStep[]): string[] => {
  const lines: string[] = []
  for (const [i, s] of steps.entries()) {
    lines.push(`${i + 1}. ${s.step ?? '(outside a step)'}  ${s.primitive}  [${s.mode}]`)
    if (s.guide !== null) lines.push(`   guide: ${s.guide}`)
  }
  return lines
}

/** Validated input surface of `mars workflow author`. */
const workflowAuthorInputSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,63}$/,
      'workflow name must be a lowercase slug (a-z, 0-9, hyphens; starts alphanumeric)',
    ),
  author: z.string().trim().min(1).max(120),
  body: z.string().min(1, 'workflow body is empty'),
})

const workflowAuthor: Command = {
  path: 'workflow author',
  summary:
    'author a NEW workflow from a JS body (stdin or file) — create-only; lint + dry-run gated; lands as an agent draft pending operator approval',
  usage: 'usage: mars workflow author <name> --from <-|path> [--author <id>]',
  run: async (args, deps) => {
    const nameArg = args.positional[0]
    const from = args.flags['--from']
    if (!nameArg || !from) {
      deps.err('usage: mars workflow author <name> --from <-|path> [--author <id>]')
      return { code: 1 }
    }

    let rawBody: string
    try {
      rawBody = from === '-' ? await readStdin() : readFileSync(from, 'utf8')
    } catch (err) {
      deps.err(`failed to read workflow body: ${errorMessage(err)}`)
      return { code: 1 }
    }

    const parsed = workflowAuthorInputSchema.safeParse({
      name: nameArg,
      author: args.flags['--author'] ?? 'agent:cli',
      body: rawBody,
    })
    if (!parsed.success) {
      deps.err('workflow author: input validation failed')
      for (const issue of parsed.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>'
        deps.err(`  ${path}: ${issue.message}`)
      }
      return { code: 1 }
    }
    const { name, author, body } = parsed.data

    const { userWorkflowPath, importWorkflowFile, isWorkflowLoadError } =
      await import('../../workflows/queue-workflow-store')
    const filePath = userWorkflowPath(name, deps.ctx.repoRoot)

    // Create-only (ADR-0068): an agent may ADD a pipeline but never rewire an
    // existing one — neither a file already on disk nor a reserved bundled
    // kind (whose file may merely not be scaffolded yet).
    if (existsSync(filePath)) {
      deps.err(
        `refusing to overwrite ${filePath}: \`mars workflow author\` is create-only. Pick a new name, or edit existing pipelines through the operator flow (/mars:workflow).`,
      )
      return { code: 1 }
    }
    if (bundledKinds(deps.ctx.repoRoot).has(name)) {
      deps.err(
        `'${name}' is a reserved bundled workflow kind — authoring it would rewire the default pipeline. Pick a new name; scaffold the defaults with \`mars update\`.`,
      )
      return { code: 1 }
    }

    // The exact bytes that would land on disk: provenance header + body.
    const stamped = stampAgentDraft(body, author)

    // Gate 1 — static safety lint, BEFORE anything executes the body (the
    // dry-run below runs the author's fn; this is the pre-execution screen).
    const lint = lintAgentWorkflowBody(stamped)
    if (!lint.ok) {
      deps.err('static lint failed — nothing was written:')
      for (const e of lint.errors) deps.err(`  ${e}`)
      return { code: 1 }
    }

    // Gate 2 — the validateWorkflow dry-run (the exact seam dispatch uses,
    // ADR-0067), run against a probe file in the same directory so module
    // resolution matches the real path. A failing body never lands at the
    // dispatchable `<name>-workflow.js` path.
    const { dryRunWorkflow } = await import('../../workflows/validate-workflow')
    const workflowsDir = userWorkflowsDir(deps.ctx.stateDir)
    mkdirSync(workflowsDir, { recursive: true })
    const probePath = resolve(workflowsDir, `.author-probe-${randomUUID()}.mjs`)
    let steps: DeclaredStep[]
    try {
      writeFileSync(probePath, stamped)
      let wf
      try {
        wf = await importWorkflowFile(name, probePath)
      } catch (err) {
        if (isWorkflowLoadError(err)) {
          deps.err('validation failed — nothing was written:')
          deps.err(`  ${err.message}`)
          return { code: 1 }
        }
        throw err
      }
      const dry = await dryRunWorkflow(wf, name)
      if (dry.errors.length > 0) {
        deps.err('validation failed — nothing was written:')
        for (const e of dry.errors) deps.err(`  ${e}`)
        return { code: 1 }
      }
      steps = dry.steps
    } finally {
      try {
        unlinkSync(probePath)
      } catch {
        // Probe never landed (early write failure) — nothing to clean.
      }
    }

    // Both gates passed: land the draft. It is on disk but NOT dispatch-
    // eligible — loadWorkflowByName refuses pending drafts (ADR-0067/0068).
    writeFileSync(filePath, stamped)

    // Raise the operator review item (level-triggered, ADR-0048: signature-
    // keyed on the workflow name; a re-raise bumps seen_count; `workflow
    // approve` supersedes it). Best-effort: the draft stays reviewable via
    // `mars workflow list` even if the raise fails.
    const runbook = renderRunbookLines(steps)
    try {
      const { raiseActionQueueItem } = await import('../../core/lib/action-queue')
      await raiseActionQueueItem({
        kind: WORKFLOW_DRAFT_ACTION_QUEUE_KIND,
        category: 'orchestrator',
        priority: 'high',
        title: `Self-authored workflow '${name}' awaits approval`,
        body: [
          `An agent (${author}) authored a new workflow pipeline. It passed the static lint and the validate dry-run but is NOT dispatch-eligible until you approve it.`,
          '',
          `file: ${filePath}`,
          '',
          'Declared runbook:',
          ...runbook.map((l) => `  ${l}`),
          '',
          `Approve with: mars workflow approve ${name}`,
          '',
          'Raw JS:',
          '```js',
          stamped,
          '```',
        ].join('\n'),
        payload: { workflowName: name, path: filePath, author },
        context: {},
        raisedBy: author,
        signature: name,
      })
    } catch (err) {
      deps.err(
        `warning: could not raise the action-queue review item (${errorMessage(err)}) — the draft is still pending; review with \`mars workflow show ${name}\` and approve with \`mars workflow approve ${name}\``,
      )
    }

    deps.out(`agent draft created: ${filePath}`)
    deps.out('declared runbook:')
    for (const l of runbook) deps.out(`  ${l}`)
    deps.out(`provenance: agent-draft (pending approval) — authored by ${author}`)
    deps.out(
      `NOT dispatch-eligible until an operator runs: mars workflow approve ${name}`,
    )
    return { code: 0 }
  },
}

const workflowApprove: Command = {
  path: 'workflow approve',
  summary:
    'approve a pending agent-draft workflow — the single moment agent-written JS becomes operator-privileged (ADR-0068)',
  usage: 'usage: mars workflow approve <name>',
  run: async (args, deps) => {
    const name = args.positional[0]
    if (!name) {
      deps.err('usage: mars workflow approve <name>')
      return { code: 1 }
    }

    const { userWorkflowPath, importWorkflowFile, isWorkflowLoadError } =
      await import('../../workflows/queue-workflow-store')
    const { dryRunWorkflow } = await import('../../workflows/validate-workflow')

    const filePath = userWorkflowPath(name, deps.ctx.repoRoot)
    if (!existsSync(filePath)) {
      deps.err(`no workflow file for '${name}': expected ${filePath}`)
      return { code: 1 }
    }
    const source = readFileSync(filePath, 'utf8')
    const provenance = readWorkflowProvenance(source)
    if (!provenance.pendingApproval) {
      deps.err(
        `workflow '${name}' is not a pending agent draft — nothing to approve (source: run \`mars workflow list\`)`,
      )
      return { code: 1 }
    }

    // Final gate: re-validate the exact bytes being privileged — the file may
    // have changed since it was authored.
    try {
      const wf = await importWorkflowFile(name, filePath)
      const dry = await dryRunWorkflow(wf, name)
      if (dry.errors.length > 0) {
        deps.err(`refusing to approve '${name}' — validation failed:`)
        for (const e of dry.errors) deps.err(`  ${e}`)
        return { code: 1 }
      }
    } catch (err) {
      if (isWorkflowLoadError(err)) {
        deps.err(`refusing to approve '${name}' — ${err.message}`)
        return { code: 1 }
      }
      throw err
    }

    // Remove the draft marker; the author marker survives for audit. From
    // here the file is an ordinary user-owned custom workflow (ADR-0057).
    writeFileSync(filePath, approveDraftSource(source))

    try {
      const { supersedeActionQueueItemsBySignature } = await import(
        '../../core/lib/action-queue'
      )
      await supersedeActionQueueItemsBySignature(
        WORKFLOW_DRAFT_ACTION_QUEUE_KIND,
        name,
        'workflow-approved',
        'operator:workflow-approve',
      )
    } catch (err) {
      deps.err(
        `warning: could not supersede the action-queue review item: ${errorMessage(err)}`,
      )
    }

    deps.out(`approved: ${filePath}`)
    if (provenance.author !== null) {
      deps.out(`author marker preserved for audit: ${provenance.author}`)
    }
    deps.out(`dispatch with: mars task add --workflow ${name} "<prompt>"`)
    return { code: 0 }
  },
}

const workflowGroup: Command = {
  path: 'workflow',
  summary: 'workflow subcommands',
  usage: 'usage: mars workflow <list|show|validate|render|author|approve> ...',
  run: (_args, deps) => {
    deps.err('usage: mars workflow <list|show|validate|render|author|approve> ...')
    return { code: 1 }
  },
}

export const workflowCommands: readonly Command[] = [
  workflowList,
  workflowShow,
  workflowValidate,
  workflowRender,
  workflowAuthor,
  workflowApprove,
  workflowGroup,
]
