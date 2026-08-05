/**
 * Canonical vision file helpers.
 *
 * The project vision lives at `docs/knowledge/vision.md` — one markdown file
 * per project, committed to the repo. No database row is involved.
 *
 * `readVision(root)` — returns the file's content, or null when absent.
 * `writeVisionInWorktree(worktreePath, content)` — writes the file inside a
 *   structured-write worktree (called from `dispatchVisionWrite` in server.ts).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/** Repo-relative path to the canonical vision file. */
export const VISION_PATH = 'docs/knowledge/vision.md'

/**
 * Read the project vision from `<root>/docs/knowledge/vision.md`.
 * Returns the file's raw content, or null when the file does not exist.
 */
export const readVision = async (root: string): Promise<string | null> => {
  try {
    return await readFile(join(root, VISION_PATH), 'utf8')
  } catch {
    return null
  }
}

/**
 * Write the project vision to `<worktreePath>/docs/knowledge/vision.md`.
 * Creates the parent directory when it does not exist.
 * Called from `dispatchVisionWrite` inside the structured-write worktree.
 */
export const writeVisionInWorktree = async (
  worktreePath: string,
  content: string,
): Promise<void> => {
  const target = join(worktreePath, VISION_PATH)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content, 'utf8')
}
