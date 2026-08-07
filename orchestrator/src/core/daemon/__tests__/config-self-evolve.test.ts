import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import { loadDaemonConfig } from '../config'

describe('loadDaemonConfig – selfEvolve', () => {
  let tmpDir: string

  beforeEach(() => {
    delete process.env['MARS_SELF_EVOLVE_AUTO_TRIGGER']
    delete process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD']
    delete process.env['MARS_REPO']

    tmpDir = mkdtempSync(join(tmpdir(), 'mars-cfg-self-evolve-'))
    mkdirSync(join(tmpDir, '.mars'), { recursive: true })
    process.env['MARS_REPO'] = tmpDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env['MARS_SELF_EVOLVE_AUTO_TRIGGER']
    delete process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD']
    delete process.env['MARS_REPO']
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  const writeDaemonJson = (content: unknown) =>
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), JSON.stringify(content))

  it('defaults to autoEnqueue=false and driftThresholdPct=10 with no env or file', () => {
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(false)
    expect(cfg.selfEvolve.driftThresholdPct).toBe(10)
  })

  it('reads MARS_SELF_EVOLVE_AUTO_TRIGGER=1 as true', () => {
    process.env['MARS_SELF_EVOLVE_AUTO_TRIGGER'] = '1'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(true)
  })

  it('reads MARS_SELF_EVOLVE_AUTO_TRIGGER=true as true', () => {
    process.env['MARS_SELF_EVOLVE_AUTO_TRIGGER'] = 'true'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(true)
  })

  it('reads MARS_SELF_EVOLVE_AUTO_TRIGGER=0 as false', () => {
    process.env['MARS_SELF_EVOLVE_AUTO_TRIGGER'] = '0'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(false)
  })

  it('reads MARS_SELF_EVOLVE_AUTO_TRIGGER=false as false', () => {
    process.env['MARS_SELF_EVOLVE_AUTO_TRIGGER'] = 'false'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(false)
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

  it('file autoEnqueue overrides env autoEnqueue (file > env)', () => {
    process.env['MARS_SELF_EVOLVE_AUTO_TRIGGER'] = '0'
    writeDaemonJson({ selfEvolve: { autoEnqueue: true } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(true)
  })

  it('file driftThresholdPct overrides env driftThresholdPct (file > env)', () => {
    process.env['MARS_SELF_EVOLVE_DRIFT_THRESHOLD'] = '25'
    writeDaemonJson({ selfEvolve: { driftThresholdPct: 5 } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(5)
  })

  it('invalid JSON in daemon.json falls back silently to env+defaults', () => {
    writeFileSync(join(tmpDir, '.mars', 'daemon.json'), 'NOT_VALID_JSON')
    process.env['MARS_SELF_EVOLVE_AUTO_TRIGGER'] = '1'
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(true)
    expect(cfg.selfEvolve.driftThresholdPct).toBe(10)
  })

  it('invalid selfEvolve.autoEnqueue type in file falls back to env/default', () => {
    writeDaemonJson({ selfEvolve: { autoEnqueue: 'yes' } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(false)
  })

  it('migrates old selfEvolve.autoTrigger key to autoEnqueue on read', () => {
    writeDaemonJson({ selfEvolve: { autoTrigger: true } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(true)
  })

  it('invalid selfEvolve.driftThresholdPct (negative) in file falls back to env/default', () => {
    writeDaemonJson({ selfEvolve: { driftThresholdPct: -5 } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.driftThresholdPct).toBe(10)
  })

  it('missing selfEvolve key in file falls back to env+defaults', () => {
    writeDaemonJson({ caps: { implement: 5 } })
    const cfg = loadDaemonConfig()
    expect(cfg.selfEvolve.autoEnqueue).toBe(false)
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
