/**
 * install — core logic for `mars install`.
 *
 * Reads a parsed manifest and lays every listed file down in a consumer repo.
 * Owned files are overwritten unconditionally (ADR-0004). Hybrid files are
 * written only if absent; in a clean repo they are simply written (ADR-0007
 * refuse-on-existence is handled in slice 2). Executable assets (.sh) end up
 * chmod'd +x. A mars.lock is written at the consumer repo root recording
 * version, timestamp, mode, and the list of files written.
 *
 * All side-effecting I/O is injected so the function is fully testable without
 * touching the real filesystem.
 */

import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HookRegistration {
  /** The PreToolUse matcher (e.g. 'Edit', 'Write', 'Bash'). */
  matcher: string
  /**
   * Repo-relative path to the hook script that must also appear in
   * `manifest.owned` for the registration to be applied.
   * (e.g. '.claude/hooks/block-tracked-writes.sh')
   */
  command: string
}

export interface Manifest {
  schemaVersion: number
  owned: string[]
  hybrid: string[]
  /**
   * PreToolUse hook entries to merge into .claude/settings.json.
   * Only registrations whose `command` is listed in `owned` are applied —
   * registering a hook that isn't deployed is never correct.
   */
  hookRegistrations?: HookRegistration[]
  scopes: unknown[]
}

export interface MarsLock {
  schemaVersion: number
  marsVersion: string
  installedAt: string
  mode: 'prod' | 'dev'
  files: Array<{ path: string; kind: 'owned' | 'hybrid' }>
}

export interface InstallDeps {
  /**
   * Read raw bytes from an absolute path (throws on missing file).
   */
  readBytes: (srcPath: string) => Buffer
  /**
   * Write bytes to dstPath, creating parent directories recursively.
   * When mode is supplied (e.g. 0o755) the file is chmod'd to that value
   * after writing.
   */
  writeFile: (dstPath: string, content: Buffer, mode?: number) => void
  /** Return true when the given path already exists on disk. */
  exists: (path: string) => boolean
  /** Emit one human-readable progress line. */
  log: (msg: string) => void
}

/**
 * Discriminated union result type for runInstall (slice 2/5 introduced the
 * refusal variants).
 *
 * - `success`: all files written, mars.lock created.
 * - `refused-already-installed`: mars.lock already exists at the consumer
 *   root; the user must run `mars update` instead.
 * - `refused-hybrid-collision`: one or more hybrid file destinations already
 *   exist (excluding `.claude/settings.json`, which uses merge semantics).
 *   The user must back up and remove every path in `collidingPaths` before
 *   re-running `mars install` (ADR-0007).
 *
 * Both refusal variants are STRICT no-ops: not a single file is created,
 * modified, or deleted on the consumer's disk.
 */
export type InstallResult =
  | { outcome: 'success'; lock: MarsLock }
  | { outcome: 'refused-already-installed' }
  | { outcome: 'refused-hybrid-collision'; collidingPaths: string[] }

/**
 * Hybrid path with special merge semantics — its existence does NOT trigger
 * a hybrid-collision refusal. Kept as a module-level constant so the install
 * logic and any introspecting test can reference the same source of truth.
 */
const HYBRID_MERGE_EXEMPTIONS: ReadonlySet<string> = new Set([
  '.claude/settings.json',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when a repo-relative path should be installed as executable. */
function isExecutable(relPath: string): boolean {
  return relPath.endsWith('.sh')
}

/**
 * Merge Mars-owned PreToolUse hook entries into the content of an existing
 * .claude/settings.json. All other keys are preserved. Hook entries are
 * deduplicated by command string so the operation is idempotent.
 *
 * Only registrations whose `command` path is present in `owned` are applied —
 * this prevents registering a hook script that was never deployed.
 *
 * The hook command is expanded from a repo-relative path to
 * `$CLAUDE_PROJECT_DIR/<relPath>` to match Claude Code's expected format.
 *
 * Exported for use by other install/init paths that need the same merge.
 */
export function mergeSettingsHooks(
  existingContent: Buffer,
  opts: {
    owned: string[]
    hookRegistrations?: HookRegistration[]
  },
): Buffer {
  const registrations = opts.hookRegistrations ?? []
  const ownedSet = new Set(opts.owned)
  const applicable = registrations.filter((r) => ownedSet.has(r.command))

  if (applicable.length === 0) return existingContent

  const settings = JSON.parse(existingContent.toString('utf8')) as Record<string, unknown>

  // Ensure hooks.PreToolUse is a writeable array
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {}
  }
  const hooks = settings.hooks as Record<string, unknown>
  if (!Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = []
  }
  const preToolUse = hooks.PreToolUse as Array<{
    matcher: string
    hooks: Array<{ type: string; command: string }>
  }>

  for (const reg of applicable) {
    const fullCommand = `$CLAUDE_PROJECT_DIR/${reg.command}`

    let matcherEntry = preToolUse.find((e) => e.matcher === reg.matcher)
    if (!matcherEntry) {
      matcherEntry = { matcher: reg.matcher, hooks: [] }
      preToolUse.push(matcherEntry)
    }

    // Deduplicate by command string — idempotent across multiple installs
    if (!matcherEntry.hooks.some((h) => h.command === fullCommand)) {
      matcherEntry.hooks.push({ type: 'command', command: fullCommand })
    }
  }

  return Buffer.from(JSON.stringify(settings, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run the install sequence.
 *
 * @param manifest       Parsed manifest.json
 * @param frameworkRoot  Absolute path to the framework repo root (asset source)
 * @param consumerRoot   Absolute path to the consumer repo root (install target)
 * @param marsVersion    The baked mars version string (from version.ts)
 * @param deps           Injected I/O dependencies
 */
export async function runInstall(
  manifest: Manifest,
  frameworkRoot: string,
  consumerRoot: string,
  marsVersion: string,
  deps: InstallDeps,
): Promise<InstallResult> {
  // --- guard 1: mars.lock already exists → repo is already installed ---
  // Checked BEFORE the hybrid-collision scan so the user gets the more
  // actionable "run mars update" message when both conditions hold.
  const lockPath = join(consumerRoot, 'mars.lock')
  if (deps.exists(lockPath)) {
    return { outcome: 'refused-already-installed' }
  }

  // --- guard 2: any hybrid destination already exists (ADR-0007) ---
  // .claude/settings.json is exempt: it has merge semantics and is allowed
  // to pre-exist. Owned files are NOT scanned — ADR-0004 says they overwrite
  // unconditionally.
  const collidingPaths: string[] = []
  for (const relPath of manifest.hybrid) {
    if (HYBRID_MERGE_EXEMPTIONS.has(relPath)) continue
    const dstPath = join(consumerRoot, relPath)
    if (deps.exists(dstPath)) collidingPaths.push(dstPath)
  }
  if (collidingPaths.length > 0) {
    return { outcome: 'refused-hybrid-collision', collidingPaths }
  }

  const files: MarsLock['files'] = []

  // --- owned files (always overwrite) ---
  for (const relPath of manifest.owned) {
    const srcPath = join(frameworkRoot, relPath)
    const dstPath = join(consumerRoot, relPath)
    const content = deps.readBytes(srcPath)
    const mode = isExecutable(relPath) ? 0o755 : undefined
    deps.writeFile(dstPath, content, mode)
    deps.log(`installed: ${relPath}`)
    files.push({ path: relPath, kind: 'owned' })
  }

  // --- hybrid files (write if absent; merge settings.json hooks if present) ---
  // Any non-exempt hybrid collision has already short-circuited above as a
  // `refused-hybrid-collision`, so the only existing-path case reachable here
  // is `.claude/settings.json` (the merge-exempt entry).
  for (const relPath of manifest.hybrid) {
    const dstPath = join(consumerRoot, relPath)

    if (relPath === '.claude/settings.json' && deps.exists(dstPath)) {
      // settings.json already exists: merge Mars PreToolUse hook registrations
      // into it rather than skipping the file entirely (ADR-0007 blanket-skip
      // leaves hooks inert on repos that already have a settings.json).
      const existingContent = deps.readBytes(dstPath)
      const mergedContent = mergeSettingsHooks(existingContent, manifest)
      deps.writeFile(dstPath, mergedContent)
      deps.log(`merged hooks: ${relPath}`)
      files.push({ path: relPath, kind: 'hybrid' })
      continue
    }

    const srcPath = join(frameworkRoot, relPath)
    const content = deps.readBytes(srcPath)
    const mode = isExecutable(relPath) ? 0o755 : undefined
    deps.writeFile(dstPath, content, mode)
    deps.log(`installed: ${relPath}`)
    files.push({ path: relPath, kind: 'hybrid' })
  }

  // --- mars.lock ---
  const lock: MarsLock = {
    schemaVersion: manifest.schemaVersion,
    marsVersion,
    installedAt: new Date().toISOString(),
    mode: 'prod',
    files,
  }
  deps.writeFile(lockPath, Buffer.from(JSON.stringify(lock, null, 2) + '\n'))
  deps.log('wrote mars.lock')

  return { outcome: 'success', lock }
}
