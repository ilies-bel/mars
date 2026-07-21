import { resolve } from 'node:path'

/**
 * Resolves a user-supplied path suffix within the chat-uploads root directory.
 *
 * Returns the absolute target path when the resolved path stays within
 * `uploadsRoot`, or `null` if the suffix would escape the root (path
 * traversal attack).
 *
 * The check is: after resolution, the target must start with
 * `uploadsRoot + '/'` (a child path) or equal `uploadsRoot` exactly
 * (the root itself). Anything else is rejected.
 */
export function resolveUploadPath(uploadsRoot: string, rawSuffix: string): string | null {
  const target = resolve(uploadsRoot, rawSuffix)
  if (!target.startsWith(uploadsRoot + '/') && target !== uploadsRoot) {
    return null
  }
  return target
}
