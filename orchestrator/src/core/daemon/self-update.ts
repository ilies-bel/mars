import { createHash } from 'node:crypto'
import { writeFile, rename, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export const SELF_UPDATE_ERRORS = {
  DEV_INSTALL: 'DEV_INSTALL',
  TASKS_IN_FLIGHT: 'TASKS_IN_FLIGHT',
  NO_UPDATE_AVAILABLE: 'NO_UPDATE_AVAILABLE',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  SHA256_MISMATCH: 'SHA256_MISMATCH',
  SWAP_FAILED: 'SWAP_FAILED',
} as const

export type SelfUpdateErrorCode =
  (typeof SELF_UPDATE_ERRORS)[keyof typeof SELF_UPDATE_ERRORS]

export class SelfUpdateError extends Error {
  constructor(
    public readonly code: SelfUpdateErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SelfUpdateError'
  }
}

// ---------------------------------------------------------------------------
// Dependencies interface (all side-effects are injected for testability)
// ---------------------------------------------------------------------------

export interface SelfUpdateDeps {
  /**
   * Returns 'prod' for a compiled standalone binary, 'dev' for a tsx-wrapper
   * dev install. Self-update is gated on 'prod' only.
   */
  installRoute: () => 'prod' | 'dev'

  /** Current count of tasks that are in-flight in the daemon. */
  inFlightCount: () => number

  /**
   * Read the cached framework-update state from `.mars/update.json`.
   * Returns null when the cache is absent or unreadable.
   */
  readUpdateCache: () => Promise<{ latest: string; available: boolean } | null>

  /**
   * Fetch the binary release asset at `url` and return it as a Buffer.
   * Rejects with a descriptive error on non-2xx or network failure.
   */
  fetchBuffer: (url: string) => Promise<Buffer>

  /**
   * Fetch a text asset at `url` (used for the sha256 sidecar).
   * Rejects with a descriptive error on non-2xx or network failure.
   */
  fetchText: (url: string) => Promise<string>

  /**
   * Absolute path to the currently running binary.
   * In production this is `process.execPath`. Injected so tests never
   * touch the real binary.
   */
  execPath: () => string

  /**
   * Construct the download URL for the platform binary of a given version.
   * Defaults to the GitHub Releases download URL pattern.
   */
  buildBinaryUrl: (version: string) => string

  /**
   * Construct the download URL for the sha256 sidecar of a given version.
   * Defaults to the binary URL + '.sha256'.
   */
  buildSidecarUrl: (version: string) => string

  /**
   * Rename `src` to `dest`. Both must reside on the same filesystem for
   * the swap to be atomic. Defaults to `fs.promises.rename`.
   */
  rename: (src: string, dest: string) => Promise<void>

  /**
   * Write `data` to `path` with mode 0o755. Defaults to `fs.promises.writeFile`.
   * Called to stage the new binary alongside the current one (same dir →
   * same filesystem → atomic rename).
   */
  writeFile: (path: string, data: Buffer) => Promise<void>

  /**
   * Re-exec the daemon using the newly swapped binary.
   * Expected to spawn a replacement process, unref it, and schedule
   * graceful shutdown of this process — see `restartDaemon` in server.ts.
   */
  restartDaemon: () => Promise<void>
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Returns the binary-asset name for the current process's platform and arch.
 *
 * Maps:
 *   darwin + arm64 → mars-darwin-arm64
 *   darwin + x64   → mars-darwin-x64
 *   linux  + arm64 → mars-linux-arm64
 *   linux  + x64   → mars-linux-x64
 *   win32  + x64   → mars-windows-x64.exe
 */
export const currentBinaryName = (
  platform: string = process.platform,
  arch: string = process.arch,
): string => {
  const os = platform === 'win32' ? 'windows' : platform
  const ext = platform === 'win32' ? '.exe' : ''
  return `mars-${os}-${arch}${ext}`
}

/**
 * Build the GitHub Releases download URL for the binary of a given version.
 *
 * @param version - Semver without 'v' prefix, e.g. "0.4.2"
 */
export const buildBinaryUrl = (version: string): string => {
  const tag = `v${version}`
  const name = currentBinaryName()
  return `https://github.com/ilies-bel/mars/releases/download/${tag}/${name}`
}

/**
 * Build the GitHub Releases download URL for the sha256 sidecar of the binary.
 *
 * @param version - Semver without 'v' prefix, e.g. "0.4.2"
 */
export const buildSidecarUrl = (version: string): string => `${buildBinaryUrl(version)}.sha256`

/**
 * Parse the hex digest from a sha256sum-format sidecar file.
 *
 * Expected format: `{hex64}  {filename}\n`
 *
 * Returns `null` when the content is malformed or the digest is not
 * a 64-character hex string.
 */
export const parseSidecarDigest = (sidecarText: string): string | null => {
  const digest = sidecarText.trim().split(/\s+/)[0]
  if (!digest || !/^[0-9a-f]{64}$/i.test(digest)) return null
  return digest.toLowerCase()
}

/**
 * Compute the SHA-256 hex digest of `data`.
 */
export const sha256hex = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex')

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Perform a daemon self-update:
 *   1. Refuse for dev installs (non-prod binary).
 *   2. Refuse if any tasks are currently in flight.
 *   3. Read the cached update state; refuse if no update is available.
 *   4. Download the new binary + its sha256 sidecar.
 *   5. Verify sha256 — abort WITHOUT touching the existing binary on mismatch.
 *   6. Atomic swap: stage new binary next to the current one, rename
 *      current → current.bak, rename staged → current.
 *   7. Re-exec the daemon (spawn replacement + graceful-shutdown this process).
 *
 * Throws {@link SelfUpdateError} on every non-happy path.
 * Returns `void` on success (the re-exec is already in progress; callers
 * should flush the HTTP response and let the process drain).
 *
 * All side-effects are injected via {@link SelfUpdateDeps} so the function
 * is fully testable without a real filesystem or network.
 */
export const performSelfUpdate = async (deps: SelfUpdateDeps): Promise<void> => {
  // --- Gate 1: prod-binary installs only ---
  if (deps.installRoute() === 'dev') {
    throw new SelfUpdateError(
      SELF_UPDATE_ERRORS.DEV_INSTALL,
      'Self-update is only available for prod binary installs. ' +
        'For dev installs (tsx wrapper), run: git pull && npm install.',
    )
  }

  // --- Gate 2: no tasks in flight ---
  const inFlight = deps.inFlightCount()
  if (inFlight > 0) {
    throw new SelfUpdateError(
      SELF_UPDATE_ERRORS.TASKS_IN_FLIGHT,
      `Cannot self-update while ${inFlight} task${inFlight === 1 ? ' is' : 's are'} in flight. ` +
        'Wait for all tasks to complete before updating.',
    )
  }

  // --- Gate 3: update must be available ---
  const cache = await deps.readUpdateCache()
  if (!cache || !cache.available) {
    throw new SelfUpdateError(
      SELF_UPDATE_ERRORS.NO_UPDATE_AVAILABLE,
      cache
        ? 'No update available; installed version is already up to date.'
        : 'Update cache not yet populated; daemon may still be polling GitHub.',
    )
  }

  // --- Download binary + sha256 sidecar ---
  const binaryUrl = deps.buildBinaryUrl(cache.latest)
  const sidecarUrl = deps.buildSidecarUrl(cache.latest)

  let binaryData: Buffer
  let sidecarText: string

  try {
    ;[binaryData, sidecarText] = await Promise.all([
      deps.fetchBuffer(binaryUrl),
      deps.fetchText(sidecarUrl),
    ])
  } catch (err) {
    throw new SelfUpdateError(
      SELF_UPDATE_ERRORS.DOWNLOAD_FAILED,
      `Download failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // --- Verify sha256 ---
  const expectedDigest = parseSidecarDigest(sidecarText)
  if (expectedDigest === null) {
    throw new SelfUpdateError(
      SELF_UPDATE_ERRORS.SHA256_MISMATCH,
      'SHA256 sidecar is malformed or missing a valid hex digest.',
    )
  }

  const actualDigest = sha256hex(binaryData)
  if (actualDigest !== expectedDigest) {
    throw new SelfUpdateError(
      SELF_UPDATE_ERRORS.SHA256_MISMATCH,
      `SHA256 mismatch: expected ${expectedDigest}, got ${actualDigest}. ` +
        'Aborting without touching the existing binary.',
    )
  }

  // --- Atomic swap ---
  // Write the new binary as a staging file in the same directory as the current
  // binary so that both reside on the same filesystem — required for an atomic
  // rename(2) call.
  const currentPath = deps.execPath()
  const stagingPath = `${currentPath}.update`
  const backupPath = `${currentPath}.bak`

  try {
    await deps.writeFile(stagingPath, binaryData)
  } catch (err) {
    throw new SelfUpdateError(
      SELF_UPDATE_ERRORS.SWAP_FAILED,
      `Failed to write staging binary: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  try {
    // current → .bak
    await deps.rename(currentPath, backupPath)
    // staging → current (atomic on POSIX when both are on the same fs)
    await deps.rename(stagingPath, currentPath)
  } catch (err) {
    throw new SelfUpdateError(
      SELF_UPDATE_ERRORS.SWAP_FAILED,
      `Binary swap failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // --- Re-exec daemon ---
  // restartDaemon() spawns a replacement daemon using the newly swapped binary,
  // unrefs it, and schedules SIGTERM on this process after ~100ms so the HTTP
  // response bytes flush before we exit.
  await deps.restartDaemon()
}

// ---------------------------------------------------------------------------
// Default dep factories (wired up in server.ts)
// ---------------------------------------------------------------------------

/**
 * Build the real `SelfUpdateDeps` for production use.
 *
 * @param readUpdateCache - Reader for the cached framework-update state.
 * @param inFlightCount - Returns current in-flight task count.
 * @param installRoute - Returns 'prod' or 'dev'.
 * @param restartDaemon - Re-exec entry point (from server.ts deps).
 */
export const makeSelfUpdateDeps = (opts: {
  readUpdateCache: () => Promise<{ latest: string; available: boolean } | null>
  inFlightCount: () => number
  installRoute: () => 'prod' | 'dev'
  restartDaemon: () => Promise<void>
}): SelfUpdateDeps => ({
  installRoute: opts.installRoute,
  inFlightCount: opts.inFlightCount,
  readUpdateCache: opts.readUpdateCache,
  execPath: () => process.execPath,
  buildBinaryUrl,
  buildSidecarUrl,
  fetchBuffer: async (url: string): Promise<Buffer> => {
    const res = await fetch(url, { headers: { 'User-Agent': 'mars-self-update' } })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`)
    }
    return Buffer.from(await res.arrayBuffer())
  },
  fetchText: async (url: string): Promise<string> => {
    const res = await fetch(url, { headers: { 'User-Agent': 'mars-self-update' } })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} fetching ${url}`)
    }
    return res.text()
  },
  rename: (src: string, dest: string) => rename(src, dest),
  writeFile: async (path: string, data: Buffer) => {
    await writeFile(path, data, { mode: 0o755 })
  },
  restartDaemon: opts.restartDaemon,
})
