import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { codexHeadless } from '../providers/codex-headless'

describe('codexHeadless context budget', () => {
  const originalBin = process.env.MARS_CODEX_BIN
  const dirs: string[] = []

  afterEach(() => {
    if (originalBin === undefined) delete process.env.MARS_CODEX_BIN
    else process.env.MARS_CODEX_BIN = originalBin
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('enforces the budget against a spawned codex executable reporting turn.completed usage', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-codex-budget-'))
    dirs.push(dir)
    const bin = resolve(dir, 'codex')
    writeFileSync(
      bin,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1001 } }) + "\\n")\n',
    )
    chmodSync(bin, 0o755)
    process.env.MARS_CODEX_BIN = bin

    const result = await codexHeadless.run('commit the work', {
      cwd: process.cwd(),
      maxContextTokens: 1_000,
    })

    expect(result.exitCode).toBe(138)
    expect(result.stderr).toContain('context budget exhausted (1001/1000 tokens)')
  })
})
