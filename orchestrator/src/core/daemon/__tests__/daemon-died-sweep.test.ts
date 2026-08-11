/**
 * daemon-died-sweep tests (ADR-0057 update).
 *
 * `detectAndRaiseDaemonDied` is now a no-op stub: `daemon-died` rows are
 * derived on read from the crash marker file by the derivation layer.
 * This suite verifies:
 *   - The stub always returns null (no stored row is written).
 *   - `readCrashMarker` still correctly parses / rejects marker files
 *     (used by the derivation layer).
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  detectAndRaiseDaemonDied,
  readCrashMarker,
} from '../daemon-died-sweep.js'

const makeTmpDir = (): string => mkdtempSync(resolve(tmpdir(), 'mars-daemon-died-'))

describe('daemon-died-sweep (ADR-0057 — derived kind)', () => {
  it('detectAndRaiseDaemonDied is a no-op (always returns null)', async () => {
    const dir = makeTmpDir()
    try {
      const markerPath = resolve(dir, 'daemon.crash.json')
      writeFileSync(
        markerPath,
        JSON.stringify({
          pid: 12345,
          startedAt: '2026-07-19T17:33:00.000Z',
          crashDetectedAt: '2026-07-19T18:15:00.000Z',
        }),
      )
      // The stub does not raise a stored row; derivation handles this on read.
      const result = await detectAndRaiseDaemonDied(markerPath)
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readCrashMarker returns null for absent file', () => {
    const dir = makeTmpDir()
    try {
      const result = readCrashMarker(resolve(dir, 'does-not-exist.json'))
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readCrashMarker returns null for malformed JSON', () => {
    const dir = makeTmpDir()
    try {
      const markerPath = resolve(dir, 'bad.json')
      writeFileSync(markerPath, 'not-json')
      const result = readCrashMarker(markerPath)
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readCrashMarker returns null for JSON missing required fields', () => {
    const dir = makeTmpDir()
    try {
      const markerPath = resolve(dir, 'partial.json')
      writeFileSync(markerPath, JSON.stringify({ pid: 1 }))
      const result = readCrashMarker(markerPath)
      expect(result).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readCrashMarker parses a valid crash marker', () => {
    const dir = makeTmpDir()
    try {
      const markerPath = resolve(dir, 'daemon.crash.json')
      const info = {
        pid: 4242,
        startedAt: '2026-07-01T09:00:00.000Z',
        crashDetectedAt: '2026-07-01T09:45:00.000Z',
      }
      writeFileSync(markerPath, JSON.stringify(info))
      const result = readCrashMarker(markerPath)
      expect(result).toEqual(info)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
