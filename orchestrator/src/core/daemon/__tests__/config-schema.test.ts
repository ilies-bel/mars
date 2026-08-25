/**
 * Tests for `daemonConfigSchema` and its use in `readDaemonConfigFile`.
 *
 * Slice: "Zod-validate daemon.json instead of asserting its type". Before
 * this slice, `readDaemonConfigFile` did `JSON.parse(...) as
 * Record<string, unknown>` — a malformed field (e.g. `caps.implement` as a
 * string) would silently pass through and explode later at some unrelated
 * call site. Now every present field is validated through
 * `daemonConfigSchema`, and an invalid field throws a descriptive,
 * field-naming error instead.
 *
 * Test strategy: point `MARS_REPO` at a temp dir (same pattern as
 * config-paused.test.ts) so daemon.json reads/writes never touch the live
 * `.mars`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import { daemonConfigPath, daemonConfigSchema, readDaemonConfigFile } from '../config'

describe('daemonConfigSchema', () => {
  it('accepts a fully-populated daemon.json shape covering caps, levers, selfEvolve, scoring and paused', () => {
    const result = daemonConfigSchema.safeParse({
      caps: { implement: 12, triage: 8, refine: 6, setupInstall: 2, verify: 1 },
      selfEvolve: {
        driftThresholdPct: 10,
        reflectCooldownDays: 7,
      },
      scoring: { autoTrigger: false, lowTrendThreshold: 0.5, lowTrendWindow: 5 },
      controlLevers: {
        recovery: 'on',
        scoring: 'on',
        memoryCapture: 'on',
        autoRunReflect: 'off',
      },
      producerLevers: { steward_runtime_tune: { autonomy_level: 'tell' } },
      paused: true,
    })
    expect(result.success).toBe(true)
  })

  it('accepts an empty object — every field is optional so absent config degrades to defaults', () => {
    expect(daemonConfigSchema.safeParse({}).success).toBe(true)
  })

  it('rejects a present field with the wrong type', () => {
    const result = daemonConfigSchema.safeParse({ caps: { implement: 'twelve' } })
    expect(result.success).toBe(false)
  })

  it('preserves unmodelled top-level keys via passthrough (e.g. budget, qaStepList)', () => {
    const result = daemonConfigSchema.safeParse({ budget: { windowTokens: 1000 } })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).budget).toEqual({ windowTokens: 1000 })
    }
  })
})

describe('readDaemonConfigFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-cfg-schema-'))
    mkdirSync(join(tmpDir, '.mars'), { recursive: true })
    process.env['MARS_REPO'] = tmpDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env['MARS_REPO']
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const writeDaemonJson = (content: unknown): void => {
    writeFileSync(daemonConfigPath(), JSON.stringify(content))
  }

  it('returns {} when daemon.json is absent', () => {
    expect(readDaemonConfigFile()).toEqual({})
  })

  it('returns {} when daemon.json contains invalid JSON', () => {
    writeFileSync(daemonConfigPath(), 'NOT_VALID_JSON')
    expect(readDaemonConfigFile()).toEqual({})
  })

  it('returns the parsed object for a valid daemon.json', () => {
    writeDaemonJson({ caps: { implement: 5 }, paused: true })
    const result = readDaemonConfigFile()
    expect(result.paused).toBe(true)
    expect((result.caps as Record<string, unknown>).implement).toBe(5)
  })

  it('throws an error naming the field and the file path for an invalid field', () => {
    writeDaemonJson({ caps: { implement: 'not-a-number' } })
    expect(() => readDaemonConfigFile()).toThrowError(/caps\.implement/)
    expect(() => readDaemonConfigFile()).toThrowError(daemonConfigPath())
  })

  it('throws for an invalid nested selfEvolve field', () => {
    writeDaemonJson({ selfEvolve: { driftThresholdPct: 'ten' } })
    expect(() => readDaemonConfigFile()).toThrowError(/selfEvolve\.driftThresholdPct/)
  })

  it('preserves unmodelled top-level keys (passthrough)', () => {
    writeDaemonJson({ budget: { windowTokens: 1000 } })
    const result = readDaemonConfigFile()
    expect(result.budget).toEqual({ windowTokens: 1000 })
  })
})
