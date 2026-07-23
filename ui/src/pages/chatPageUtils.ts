/**
 * Pure utility functions extracted from ChatPage.tsx so that ChatPage.tsx
 * exports only React components, keeping React Fast Refresh working.
 */

import type { ActionQueueItem, ChatSegmentAttachment } from '@/shared/schemas'

const PRIORITY_RANK: Record<'high' | 'normal' | 'low', number> = {
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
