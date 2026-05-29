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

export interface Manifest {
  schemaVersion: number
  owned: string[]
  hybrid: string[]
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

export type InstallOutcome = 'success'

export interface InstallResult {
  outcome: InstallOutcome
  lock: MarsLock
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when a repo-relative path should be installed as executable. */
function isExecutable(relPath: string): boolean {
  return relPath.endsWith('.sh')
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

  // --- hybrid files (write only if absent) ---
  for (const relPath of manifest.hybrid) {
    const dstPath = join(consumerRoot, relPath)
    if (deps.exists(dstPath)) {
      deps.log(`skip (exists): ${relPath}`)
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
  const lockPath = join(consumerRoot, 'mars.lock')
  deps.writeFile(lockPath, Buffer.from(JSON.stringify(lock, null, 2) + '\n'))
  deps.log('wrote mars.lock')

  return { outcome: 'success', lock }
}
