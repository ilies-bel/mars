import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import { loadDaemonConfig } from '../config'

describe('loadDaemonConfig – selfEvolve', () => {
  let tmpDir: string

  beforeEach(() => {
    delete process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD']
    delete process.env['MARS_REPO']

    tmpDir = mkdtempSync(join(tmpdir(), 'mars-cfg-self-evolve-'))
    mkdirSync(join(tmpDir, '.mars'), { recursive: true })
    process.env['MARS_REPO'] = tmpDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD']
    delete process.env['MARS_REPO']
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const writeDaemonJson = (content: unknown) =>
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify(content))

  it('defaults to driftThresholdPct=10 with no env or file', () => {
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(10)
  })

  it('selfEvolve has no autoEnqueue or taskConfidenceThreshold on a fresh config', () => {
    const cfg = loadDaemonConfig()
    expect('autoEnqueue' in cfg.selfEvolve).toBe(false)
    expect('taskConfidenceThreshold' in cfg.selfEvolve).toBe(false)
  })

  it('reads MARS_SELF_EVOLVE_DRIFT_THRESHOLD=25 as 25', () => {
    process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD'] = '25'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(25)
  })

  it('supports fractional MARS_SELF_EVOLVE_DRIFT_THRESHOLD', () => {
    process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD'] = '2.5'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(2.5)
  })

  it('falls back to default when MARS_SELF_EVOLVE_DRIFT_THRESHOLD is not a number', () => {
    process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD'] = 'notanumber'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(10)
  })

  it('falls back to default when MARS_SELF_EVOLVE_DRIFT_THRESHOLD is non-positive', () => {
    process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD'] = '-5'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(10)
  })

  it('file driftThresholdPct overrides env driftThresholdPct (file > env)', () => {
    process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD'] = '25'
    writeDaemonJson({ selfEvolve: { driftThresholdPct: 5 } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(5)
  })

  it('existing daemon.json carrying selfEvolve.autoEnqueue loads without error (criterion 3)', () => {
    // Real deployments may still have this key; it should be silently ignored.
    writeDaemonJson({ selfEvolve: { autoEnqueue: true, driftThresholdPct: 7 } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(7)
    expect('autoEnqueue' in cfg.selfEvolve).toBe(false)
  })

  it('existing daemon.json carrying selfEvolve.taskConfidenceThreshold loads without error', () => {
    writeDaemonJson({ selfEvolve: { taskConfidenceThreshold: 0.9, driftThresholdPct: 12 } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(12)
    expect('taskConfidenceThreshold' in cfg.selfEvolve).toBe(false)
  })

  it('invalid JSON in daemon.json falls back silently to env+defaults', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), 'NOT_VALID_JSON')
    process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD'] = '15'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(15)
  })

  it('invalid selfEvolve.driftThresholdPct (negative) in file falls back to env/default', () => {
    writeDaemonJson({ selfEvolve: { driftThresholdPct: -5 } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(10)
  })

  it('missing selfEvolve key in file falls back to env+defaults', () => {
    writeDaemonJson({ caps: { implement: 5 } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(10)
  })

  it('controlLevers default: memoryCapture=on, autoRunReflect=off with no file', () => {
    const cfg = loadDaemonConfig()
    expect(cfg.controlLevers.memoryCapture).toBe('on')
    expect(cfg.controlLevers.autoRunReflect).toBe('off')
  })

  it('controlLevers migrates old autoReflect key to memoryCapture', () => {
    writeDaemonJson({ controlLevers: { autoReflect: 'off' } })
    const cfg = loadDaemonConfig()
    expect(cfg.controlLevers.memoryCapture).toBe('off')
  })
})
