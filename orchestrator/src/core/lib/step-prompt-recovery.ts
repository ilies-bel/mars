/**
 * Best-effort recovery of a step's composed worker prompt from stored
 * transcripts — the fallback path for runs that predate prompt persistence
 * (`promptText` on the `step_started` payload, written by
 * `run-worker-with-span.ts`).
 *
 * A `claude -p` conversation transcript opens with the user message carrying
 * the exact prompt the worker was given. Both stored transcript forms — the
 * streaming `task_transcripts` chunks and the durable
 * `task_durable_transcripts` blob — are flat arrays of stream-json events, so
 * recovery is "find the first user message and pull its text". The on-disk
 * `~/.claude/projects/{proj}/<sessionId>.jsonl` transcript uses the same event
 * envelope, one JSON object per line.
 *
 * Everything here is pure/read-only and never throws: recovery is a labelled
 * best-effort ('recovered from transcript' in the UI), never passed off as
 * first-class persisted data.
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Extracts the text of the FIRST user message from a flat list of claude
 * stream-json events (`{ type: 'user', message: { content: … } }`).
 *
 * Handles both content shapes the CLI emits: a plain string, or an array of
 * content blocks from which every `{ type: 'text', text }` block is joined.
 * Returns `null` when no user message with non-empty text exists.
 */
export const extractFirstUserMessageText = (events: readonly unknown[]): string | null => {
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue
    const event = raw as Record<string, unknown>
    if (event.type !== 'user') continue
    const message = event.message
    if (typeof message !== 'object' || message === null) continue
    const content = (message as Record<string, unknown>).content
    if (typeof content === 'string') {
      if (content.length > 0) return content
      continue
    }
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            typeof block === 'object' &&
            block !== null &&
            (block as Record<string, unknown>).type === 'text' &&
            typeof (block as Record<string, unknown>).text === 'string',
        )
        .map((block) => block.text)
        .join('\n')
      if (text.length > 0) return text
    }
  }
  return null
}

/**
 * Scans `~/.claude/projects/{proj}/<sessionId>.jsonl` for the session's on-disk
 * transcript and extracts the first user message from it.
 *
 * The claude CLI keys each project directory by a munged cwd we cannot
 * reconstruct here, so every project directory is checked for the session
 * file (one flat readdir + at most one file read per directory — cheap, and
 * only reached on the lazy Show-trace path for pre-persistence runs).
 *
 * `baseDir` overrides the `~/.claude/projects` root in tests. Returns `null`
 * on any miss or IO error — recovery is best-effort by contract.
 */
export const recoverPromptFromDiskTranscript = async (
  sessionId: string,
  baseDir?: string,
): Promise<string | null> => {
  if (sessionId.length === 0 || sessionId.includes('/') || sessionId.includes('..')) {
    return null
  }
  const projectsRoot = baseDir ?? join(homedir(), '.claude', 'projects')
  let projectDirs: string[]
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true })
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return null
  }
  for (const dir of projectDirs) {
    const candidate = join(projectsRoot, dir, `${sessionId}.jsonl`)
    let raw: string
    try {
      raw = await readFile(candidate, 'utf8')
    } catch {
      continue
    }
    const events: unknown[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        // Skip unparseable lines — partial writes happen on live sessions.
      }
    }
    const text = extractFirstUserMessageText(events)
    if (text !== null) return text
  }
  return null
}
