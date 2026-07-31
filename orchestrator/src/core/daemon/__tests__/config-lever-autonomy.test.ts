import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import {
  AUTONOMOUS_AUTONOMY_LEVEL,
  STEWARD_PROMPT_OPTIMIZER_LEVER,
  readLeverAutonomyLevel,
} from '../config'

describe('readLeverAutonomyLevel', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mars-cfg-lever-autonomy-'))
    mkdirSync(join(tmpDir, '.mars'), { recursive: true })
    process.env.MARS_REPO = tmpDir
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    __resetContextCacheForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rejects a persisted retired autonomy level instead of changing it to the default', () => {
    writeFileSync(
      join(tmpDir, '.mars', 'daemon.json'),
      JSON.stringify({ levers: { steward_runtime_tune: { autonomy_level: 'silent' } } }),
    )

    expect(() => readLeverAutonomyLevel('steward_runtime_tune')).toThrow(
      /retired autonomy level 'silent'.*'off', 'ask', or 'tell'/i,
    )
  })

  it('defaults the prompt optimizer to the shared autonomous level', () => {
    expect(readLeverAutonomyLevel(STEWARD_PROMPT_OPTIMIZER_LEVER)).toBe(
      AUTONOMOUS_AUTONOMY_LEVEL,
    )
  })
})
