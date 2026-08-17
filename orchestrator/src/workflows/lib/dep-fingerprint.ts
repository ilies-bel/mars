import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MANIFEST_FILES = ['package.json'] as const
const LOCKFILE_CANDIDATES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const

/**
 * Compute a stable SHA-256 fingerprint of a worktree's package manifests and
 * lockfiles. Returns null when neither package.json nor any lockfile is present.
 *
 * The fingerprint is deterministic: byte-identical file contents produce the
 * same fingerprint across calls. Each contributing file is included in the hash
 * as a `${relPath}\n${sha256(content)}\n` entry so that both file identity and
 * content are captured.
 */
export async function computeDepFingerprint(worktreeRoot: string): Promise<string | null> {
  const outer = createHash('sha256')
  let anyContributor = false

  // Always include package.json when present.
  for (const name of MANIFEST_FILES) {
    const contributed = await hashFileInto(outer, worktreeRoot, name)
    if (contributed) anyContributor = true
  }

  // Include the first lockfile found among the candidates (ordered preference).
  for (const name of LOCKFILE_CANDIDATES) {
    const contributed = await hashFileInto(outer, worktreeRoot, name)
    if (contributed) {
      anyContributor = true
      break
    }
  }

  return anyContributor ? outer.digest('hex') : null
}

/** Hash one file into the outer hasher. Returns true when the file was read. */
async function hashFileInto(
  outer: ReturnType<typeof createHash>,
  root: string,
  relPath: string,
): Promise<boolean> {
  let content: Buffer
  try {
    content = await readFile(join(root, relPath))
  } catch {
    // File absent or unreadable — omit from hash rather than crashing.
    return false
  }

  const fileHash = createHash('sha256').update(content).digest('hex')
  outer.update(`${relPath}\n${fileHash}\n`)
  return true
}
