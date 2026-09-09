/**
 * Pure utility functions extracted from ChatPage.tsx so that ChatPage.tsx
 * exports only React components, keeping React Fast Refresh working.
 */

import type { ActionQueueItem, ChatSegmentAttachment } from '@/shared/schemas'
import { titleFromPrompt } from '@/shared/promptTitle'

// ---------------------------------------------------------------------------
// relativeTime — human-readable relative timestamp
// ---------------------------------------------------------------------------

/**
 * Converts an ISO timestamp to a short relative label:
 *   < 1 min  → "just now"
 *   < 1 hour → "Xm ago"
 *   < 1 day  → "Xh ago"
 *   otherwise → "Xd ago"
 *
 * @param iso    ISO-8601 timestamp string
 * @param nowMs  Optional anchor (ms since epoch) — defaults to Date.now().
 *               Accepting an explicit anchor makes the function testable
 *               without time mocking.
 */
export const relativeTime = (iso: string, nowMs: number = Date.now()): string => {
  const diff = nowMs - new Date(iso).getTime()
  if (diff <= 0) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// smartTitle — strip verbose category prefixes from thread titles
// ---------------------------------------------------------------------------

/**
 * Common verbose prefixes that systems attach to auto-generated thread titles.
 * Stripping them reveals the meaningful part (e.g. the task ID).
 */
const TITLE_PREFIXES = [
  'Phantom task auto-',
] as const

/**
 * Returns a compact, human-readable display title for a thread:
 *   - null / empty + firstUserMessage → derived from the first user message via titleFromPrompt
 *   - null / empty + no firstUserMessage → "New thread"
 *   - known verbose prefix → the portion after the prefix
 *   - anything else → the title unchanged
 *
 * @param title          The stored thread title (null or empty when not yet named).
 * @param firstUserMessage  The text of the thread's first user message, used as a
 *                       fallback title source when no explicit title exists.
 *                       Pass null/undefined for threads that have no messages yet.
 */
export const smartTitle = (title: string | null, firstUserMessage?: string | null): string => {
  if (!title) {
    if (firstUserMessage) return titleFromPrompt(firstUserMessage)
    return 'New thread'
  }
  for (const prefix of TITLE_PREFIXES) {
    if (title.startsWith(prefix)) return title.slice(prefix.length)
  }
  return title
}

/**
 * The NAME a thread goes by in the sidebar list.
 *
 * `smartTitle` returns the stored title, which for an alert thread is the
 * alert's full advisory sentence:
 *
 *   "A task got stuck and Mars used up its automatic retry — nothing is fixing
 *    this now, you need to decide what to do (mars-…"
 *
 * That is 944px of text, and the list column gives the title 98px. Measured on
 * a live session: two threads both rendered as "A task got s…" and were
 * indistinguishable, with no `title` attribute so hover revealed nothing
 * either. The sidebar's only job is choosing a thread, and it could not be
 * done.
 *
 * A name is a noun phrase; an advisory is one or more sentences. The same
 * distinction TriagePage draws for its headline slot. So this keeps the lead
 * clause — the part that names the subject — and drops the part that gives
 * advice, which the transcript itself states in full the moment the thread is
 * opened:
 *
 *   "A task got stuck and Mars used up its automatic retry"
 *   "An update is available for the background engine (5 commits behind)"
 *   "Mars could not turn this PRD into tasks"
 *
 * Nothing is rewritten or summarised — the words are the daemon's own, cut at
 * a boundary it wrote. A title that was already a name is returned unchanged.
 */
export const threadListTitle = (
  title: string | null,
  firstUserMessage?: string | null,
): string => {
  const full = smartTitle(title, firstUserMessage)

  // A leading markdown heading marker is chrome from a pasted prompt body.
  let text = full.replace(/^#{1,6}\s+/, '').trim()

  // Cut at the first clause boundary that separates subject from advice. The
  // em dash is the daemon's own convention for exactly that; a sentence stop
  // is the general case. Both must be followed by more text, so a trailing
  // period never counts as a cut.
  const cut = text.search(/\s+—\s+|[.!?](\s|$)/)
  if (cut > 0) {
    const head = text.slice(0, cut).trim()
    // Only take the head if it is substantial enough to still be a name. A
    // three-word fragment is worse than the whole sentence.
    if (head.length >= 16) text = head
  }

  // The API stores a bounded title, so a long advisory arrives already cut —
  // sometimes mid-token, leaving "(mars-" hanging. Drop a dangling opener
  // rather than printing half of one.
  text = text.replace(/\s*\([^)]*$/, '').trim()

  return text.length > 0 ? text : full
}

export const PRIORITY_RANK: Record<'high' | 'normal' | 'low', number> = {
  high: 0,
  normal: 1,
  low: 2,
}

/**
 * Returns the most important open action-queue alert from a list.
 * Sort key: priority (high → normal → low), then `at` descending (newest tiebreak).
 * Returns null for an empty list.
 */
export const pickTopAlert = (items: ActionQueueItem[]): ActionQueueItem | null => {
  if (items.length === 0) return null
  return [...items].sort((a, b) => {
    const pd = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    if (pd !== 0) return pd
    // newest first: lexicographic ISO-string comparison works because
    // all at-values use the same UTC format
    return b.at.localeCompare(a.at)
  })[0] ?? null
}

/**
 * Returns the top N action-queue rows sorted by priority (high first),
 * then newest first. Used by the opening next-move chips beneath the
 * seeded Mars message.
 */
export const topRowsByPriority = (items: ActionQueueItem[], n: number): ActionQueueItem[] =>
  [...items]
    .sort((a, b) => {
      const pd = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
      if (pd !== 0) return pd
      return b.at.localeCompare(a.at)
    })
    .slice(0, n)

/**
 * Derives the media kind from a segment's kindHint or mimeType.
 * Returns 'image', 'audio', 'video', or 'other'.
 */
export const resolveMediaKind = (attachment: ChatSegmentAttachment): 'image' | 'audio' | 'video' | 'other' => {
  if (attachment.kindHint) return attachment.kindHint
  const mime = attachment.mimeType.toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return 'other'
}

/** Determine if a file is an image, audio, or video from its MIME type. */
export const fileMediaKind = (file: File): 'image' | 'audio' | 'video' | 'other' => {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/')) return 'audio'
  if (file.type.startsWith('video/')) return 'video'
  return 'other'
}
