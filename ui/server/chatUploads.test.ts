/**
 * Tests for the chat-uploads path-traversal guard (resolveUploadPath).
 *
 * The guard protects the GET /api/chat/uploads/* route from path-traversal
 * attacks. It must return null for any suffix that would resolve outside the
 * uploads root, and the absolute target path for safe suffixes.
 */

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { resolveUploadPath } from './chatUploadPath.ts'

const ROOT = '/data/.mars/chat-uploads'

describe('resolveUploadPath – safe paths', () => {
  it('returns the absolute path for a simple filename', () => {
    expect(resolveUploadPath(ROOT, 'photo.jpg')).toBe(`${ROOT}/photo.jpg`)
  })

  it('returns the absolute path for a subdirectory path', () => {
    expect(resolveUploadPath(ROOT, 'thread-1/audio.mp3')).toBe(
      `${ROOT}/thread-1/audio.mp3`,
    )
  })

  it('resolves single-dot references to the expected path', () => {
    // 'thread-1/./file.png' normalises to 'thread-1/file.png'
    expect(resolveUploadPath(ROOT, 'thread-1/./file.png')).toBe(
      `${ROOT}/thread-1/file.png`,
    )
  })

  it('returns the root path itself for an empty suffix', () => {
    // resolve(ROOT, '') === ROOT — the empty suffix is the root itself
    expect(resolveUploadPath(ROOT, '')).toBe(ROOT)
  })

  it('returns the root path itself for a "." suffix', () => {
    expect(resolveUploadPath(ROOT, '.')).toBe(ROOT)
  })
})

describe('resolveUploadPath – path traversal attacks', () => {
  it('rejects a direct "../" traversal', () => {
    // One level up escapes the uploads root
    expect(resolveUploadPath(ROOT, '../secret.txt')).toBeNull()
  })

  it('rejects a multi-level "../" traversal', () => {
    expect(resolveUploadPath(ROOT, '../../etc/passwd')).toBeNull()
  })

  it('rejects traversal embedded in a subdirectory path', () => {
    // Looks safe but resolves outside root
    expect(resolveUploadPath(ROOT, 'thread-1/../../outside.txt')).toBeNull()
  })

  it('rejects an absolute path that starts outside the root', () => {
    expect(resolveUploadPath(ROOT, '/etc/passwd')).toBeNull()
  })

  it('rejects an absolute path that coincidentally starts with the root prefix but is a sibling', () => {
    // e.g. /data/.mars/chat-uploads-evil is NOT inside /data/.mars/chat-uploads/
    // resolve() with an absolute path returns the absolute path itself
    expect(resolveUploadPath(ROOT, `${ROOT}-sibling/file.txt`)).toBeNull()
  })

  it('rejects URL-encoded traversal after decoding', () => {
    // The route decodes the suffix before calling resolveUploadPath,
    // so by the time the helper sees it the string is already decoded.
    // This test verifies the decoded form is rejected.
    expect(resolveUploadPath(ROOT, '../etc/passwd')).toBeNull()
  })
})

describe('resolveUploadPath – root boundary', () => {
  it('is anchored to the exact root string (no prefix-only match)', () => {
    // The root is /data/.mars/chat-uploads.
    // A file at /data/.mars/chat-uploadsSuffix/file.txt starts with the root
    // string but NOT with root + '/', so it must be rejected.
    const sibling = resolve(ROOT, '..', 'chat-uploadsSuffix', 'file.txt')
    const suffix = '../chat-uploadsSuffix/file.txt'
    // The guard uses startsWith(root + '/'), not startsWith(root), to avoid
    // this false-positive — verify the helper rejects it.
    expect(resolveUploadPath(ROOT, suffix)).toBeNull()
    // Sanity: the sibling path does start with ROOT (no slash) — that's exactly
    // the attack the '/' anchoring prevents.
    expect(sibling.startsWith(ROOT + '/')).toBe(false)
    expect(sibling.startsWith(ROOT)).toBe(true)
  })
})
