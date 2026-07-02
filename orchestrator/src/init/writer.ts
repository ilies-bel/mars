import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import {
  agentsMdPathForScope,
  removeAgentsBlock,
  upsertAgentsBlock,
} from './agents-md'
import type { SupervisorSpec } from './detect-stack'
import { readInitManifest, writeInitManifest } from './init-manifest'
import { loadCatalogue, lookupCatalogue } from './per-stack-catalogue'

export type SupervisorOutcomeKind = 'hit' | 'miss' | 'error'

export interface VerifyStepEntry {
  name: string
  cmd: string
  args: string[]
  required: boolean
  /**
   * Working directory for the step, relative to the repo root. '.' for the
   * root scope. Optional for legacy supervisor-default steps; required for
   * steps compiled from a manifest.json `scopes[]` entry.
   */
  cwd?: string
  /**
   * 'task': cheap gate (typecheck, lint). Runs in the per-task verify phase.
   * 'integration': expensive gate (full test suite). Deferred to integration
   * boundary; not run during per-task verify. Omit for the default 'task'.
   */
  tier?: 'task' | 'integration'
}

export interface SlimInitInput {
  repoRoot: string
  contextPath: string
  adrDir: string
}

export interface SlimInitResult {
  written: string[]
}

const CONTEXT_SKELETON = `# Project Context

Canonical domain terms for this project. Edited via \`mars glossary\`.

## Language
`

export const writeSlimInit = (input: SlimInitInput): SlimInitResult => {
  const written: string[] = []

  if (!existsSync(input.contextPath)) {
    mkdirSync(dirname(input.contextPath), { recursive: true })
    writeFileSync(input.contextPath, CONTEXT_SKELETON, 'utf8')
    written.push(relative(input.repoRoot, input.contextPath))
  }

  mkdirSync(input.adrDir, { recursive: true })

  return { written }
}

export interface RenderedSupervisor {
  spec: SupervisorSpec
  content: string
  outcome: SupervisorOutcomeKind
  triedSlugs: string[]
  externalSource: { slug: string; path: string } | null
  verify?: VerifyStepEntry[]
}

export interface WriteContext {
  repoRoot: string
  supervisorsDir: string
  supervisorsManifest: string
}

export interface StackSummary {
  languages: string[]
  frameworks: string[]
  infra: string[]
  mobile: string[]
  specialized: string[]
}

export interface WriteResult {
  supervisorsDir: string
  written: string[]
  removed: string[]
  outcomes: Array<{
    name: string
    outcome: SupervisorOutcomeKind
    triedSlugs: string[]
    externalSource: { slug: string; path: string } | null
  }>
}

interface PreviousManifestEntry {
  name: string
  scope: string
}

const readPreviousManifest = (manifestPath: string): PreviousManifestEntry[] => {
  if (!existsSync(manifestPath)) return []
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      supervisors?: Array<{ name?: string; scope?: string }>
    }
    if (!parsed.supervisors) return []
    return parsed.supervisors
      .filter((s): s is { name: string; scope?: string } => typeof s?.name === 'string')
      .map((s) => ({ name: s.name, scope: s.scope ?? '.' }))
  } catch {
    return []
  }
}

export const writeSupervisors = (
  ctx: WriteContext,
  stack: StackSummary,
  rendered: RenderedSupervisor[],
  now: () => string = () => new Date().toISOString(),
): WriteResult => {
  mkdirSync(ctx.supervisorsDir, { recursive: true })

  const previous = readPreviousManifest(ctx.supervisorsManifest)
  const currentKeys = new Set(
    rendered.map((r) => `${r.spec.name}::${r.spec.scope}`),
  )

  const written: string[] = []
  const removed: string[] = []

  for (const prev of previous) {
    const key = `${prev.name}::${prev.scope}`
    if (currentKeys.has(key)) continue
    const filePath = agentsMdPathForScope(ctx.repoRoot, prev.scope)
    const result = removeAgentsBlock(filePath, prev.name, prev.scope)
    if (result.removed) removed.push(relative(ctx.repoRoot, filePath))
  }

  const entries = rendered.map((r) => {
    const scope = r.spec.scope
    const filePath = agentsMdPathForScope(ctx.repoRoot, scope)
    upsertAgentsBlock({
      filePath,
      supervisorName: r.spec.name,
      scope,
      body: r.content,
    })
    const relPath = relative(ctx.repoRoot, filePath)
    if (!written.includes(relPath)) written.push(relPath)
    return {
      name: r.spec.name,
      persona: r.spec.persona,
      kind: r.spec.kind,
      scope,
      // verifyCwd declares where verify commands should run for this supervisor.
      // Defaults to scope so resolveVerifyCwd/resolveTaskCwd can use it as a
      // first-class override for non-JS monorepos (Kotlin, Python, Rust, …)
      // where the TS-specific heuristic (package.json + tsconfig.json) does
      // not fire.
      verifyCwd: scope,
      path: relPath,
      outcome: r.outcome,
      triedSlugs: r.triedSlugs,
      externalSource: r.externalSource,
      lines: r.content.split('\n').length,
      ...(r.verify ? { verify: r.verify } : {}),
    }
  })

  const manifest = {
    version: 1 as const,
    generatedAt: now(),
    stack,
    supervisors: entries,
    removed,
  }
  writeFileSync(
    ctx.supervisorsManifest,
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8',
  )
  written.push(relative(ctx.repoRoot, ctx.supervisorsManifest))

  return {
    supervisorsDir: ctx.supervisorsDir,
    written,
    removed,
    outcomes: entries.map((e) => ({
      name: e.name,
      outcome: e.outcome,
      triedSlugs: e.triedSlugs,
      externalSource: e.externalSource,
    })),
  }
}

export interface PerFolderClaudeMdInput {
  repoRoot: string
  /**
   * Path to the `.mars` state directory.  When provided, the function reads
   * the init manifest to determine which CLAUDE.md files it previously wrote
   * (Mars-owned) vs. files the user created by hand.  On a re-run, existing
   * CLAUDE.md files that are NOT in the manifest are left untouched.  After
   * writing, the manifest is updated to reflect the current set of per-folder
   * CLAUDE.md paths.
   *
   * When omitted (e.g. in tests that exercise the raw write behaviour), no
   * manifest reading or writing takes place and every supervisor directory
   * gets a CLAUDE.md regardless of pre-existing content.
   */
  marsDir?: string
  supervisors: ReadonlyArray<SupervisorSpec>
}

export interface PerFolderClaudeMdResult {
  written: string[]
}

/**
 * Write a per-folder CLAUDE.md into every detected manifest directory that
 * is not the repo root. Content comes from the committed per-stack catalogue
 * keyed by supervisor name; unknown supervisor names fall back to the generic
 * baseline. Fully offline — no network access required.
 *
 * When `marsDir` is provided the function consults the init manifest:
 * - First run (no manifest yet): all supervisor CLAUDE.md files are written.
 * - Re-run (manifest exists): a CLAUDE.md that already exists on disk and was
 *   NOT in the manifest is treated as hand-written and left untouched; a
 *   CLAUDE.md that IS in the manifest (Mars-owned) is overwritten with the
 *   latest catalogue content; a new supervisor directory that has no CLAUDE.md
 *   yet gets one written regardless.
 * After writing, the manifest is updated to reflect the per-folder CLAUDE.md
 * paths written on this run.
 */
export const writePerFolderClaudeMds = (
  input: PerFolderClaudeMdInput,
): PerFolderClaudeMdResult => {
  const catalogue = loadCatalogue()

  // Determine which CLAUDE.md paths were written by mars init previously.
  const manifestExists =
    input.marsDir ? existsSync(resolve(input.marsDir, 'init-manifest.json')) : false
  const marsOwned = new Set(
    manifestExists ? readInitManifest(input.marsDir!) : [],
  )

  const written: string[] = []
  for (const supervisor of input.supervisors) {
    if (supervisor.scope === '.') continue
    const dir = resolve(input.repoRoot, supervisor.scope)
    mkdirSync(dir, { recursive: true })
    const filePath = resolve(dir, 'CLAUDE.md')
    const relPath = relative(input.repoRoot, filePath)

    // On a re-run: skip CLAUDE.md files that exist but were not written by
    // mars init (treat them as hand-written and leave them untouched).
    if (manifestExists && existsSync(filePath) && !marsOwned.has(relPath)) continue

    const content = lookupCatalogue(catalogue, supervisor.name)
    writeFileSync(filePath, content, 'utf8')
    written.push(relPath)
  }

  // Persist the manifest so the next run knows which files mars owns.
  if (input.marsDir !== undefined) {
    writeInitManifest(input.marsDir, written)
  }

  return { written }
}

export interface PurgeStaleMdsResult {
  purged: string[]
}

/**
 * Delete every `.md` file in the supervisors directory — these are briefing
 * files written by the old per-stack supervisor system and are no longer
 * produced by `writeSlimInit`.  Non-`.md` files (e.g. `manifest.json`,
 * `detection-report.json`) are left untouched.
 */
export const purgeStaleSupervisorMds = (supervisorsDir: string): PurgeStaleMdsResult => {
  if (!existsSync(supervisorsDir)) return { purged: [] }
  const purged: string[] = []
  for (const name of readdirSync(supervisorsDir)) {
    if (!name.endsWith('.md')) continue
    rmSync(resolve(supervisorsDir, name), { force: true })
    purged.push(name)
  }
  return { purged }
}
