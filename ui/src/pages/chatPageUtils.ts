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
