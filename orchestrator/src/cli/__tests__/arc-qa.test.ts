import { describe, it, expect } from 'vitest'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ArcQaManifest } from '../../core/lib/arc-qa-manifest'

const here = dirname(fileURLToPath(import.meta.url))
// src/cli/__tests__ -> src/cli -> src -> orchestrator
const projectRoot = resolve(here, '..', '..', '..')
const cliEntry = resolve(projectRoot, 'src', 'cli.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const runCli = (
  args: readonly string[],
  env?: Record<string, string>,
): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [tsxBin, cliEntry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15_000,
  })

const withTempRepo = (fn: (tmpDir: string) => void): void => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'mars-arc-qa-test-'))
  mkdirSync(join(tmpDir, '.mars'), { recursive: true })
  try {
    fn(tmpDir)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

const writeManifest = (
  tmpDir: string,
  originId: string,
  manifest: ArcQaManifest,
): void => {
  const dir = join(tmpDir, '.mars', 'arc-qa', originId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
}

describe('mars arc qa --help', () => {
  it('exits 0 and prints the command summary', () => {
    const result = runCli(['arc', 'qa', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('arc')
    expect(result.stdout).toMatch(/qa/i)
  })

  it('documents the originId argument', () => {
    const result = runCli(['arc', 'qa', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/originId|origin.id/i)
  })
})

describe('mars arc qa — missing manifest', () => {
  it('exits non-zero when no manifest exists', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['arc', 'qa', 'test-origin-001'], {
        MARS_REPO: tmpDir,
      })
      expect(result.status).not.toBe(0)
    })
  })

  it('prints the expected message to stderr', () => {
    withTempRepo((tmpDir) => {
      const result = runCli(['arc', 'qa', 'test-origin-001'], {
        MARS_REPO: tmpDir,
      })
      expect(result.stderr).toContain(
        'no QA manifest for arc test-origin-001 (E2E pass may not have run)',
      )
    })
  })
})

describe('mars arc qa — happy path', () => {
  it('lists each criterion with its steps', () => {
    withTempRepo((tmpDir) => {
      const originId = 'arc-happy-001'
      const manifest: ArcQaManifest = {
        originId,
        generatedAt: Date.now(),
        criteria: [
          {
            criterion: 'The widget renders',
            steps: [
              { index: 1, text: 'Open browser', screenshotPath: null },
              { index: 2, text: 'Navigate to page', screenshotPath: null },
            ],
            stoppedAtStep: null,
            stopReason: null,
          },
        ],
      }
      writeManifest(tmpDir, originId, manifest)
      const result = runCli(['arc', 'qa', originId], { MARS_REPO: tmpDir })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Criterion: The widget renders')
      expect(result.stdout).toContain('1. Open browser')
      expect(result.stdout).toContain('2. Navigate to page')
    })
  })

  it('marks the stopped step with → and [stopped: <reason>]', () => {
    withTempRepo((tmpDir) => {
      const originId = 'arc-stopped-001'
      const manifest: ArcQaManifest = {
        originId,
        generatedAt: Date.now(),
        criteria: [
          {
            criterion: 'Login flow works',
            steps: [
              { index: 1, text: 'Click login', screenshotPath: null },
              { index: 2, text: 'Fill credentials', screenshotPath: null },
              { index: 3, text: 'Submit form', screenshotPath: null },
            ],
            stoppedAtStep: 2,
            stopReason: 'element not found',
          },
        ],
      }
      writeManifest(tmpDir, originId, manifest)
      const result = runCli(['arc', 'qa', originId], { MARS_REPO: tmpDir })
      expect(result.status).toBe(0)
      // Stopped step has the → prefix and the annotation
      expect(result.stdout).toMatch(/→\s+2\.\s+Fill credentials/)
      expect(result.stdout).toContain('[stopped: element not found]')
      // Non-stopped steps do not have the annotation
      expect(result.stdout).not.toMatch(/→\s+1\./)
      expect(result.stdout).not.toMatch(/→\s+3\./)
    })
  })

  it('prints the absolute screenshot path for steps with a screenshot', () => {
    withTempRepo((tmpDir) => {
      const originId = 'arc-screenshot-001'
      const manifest: ArcQaManifest = {
        originId,
        generatedAt: Date.now(),
        criteria: [
          {
            criterion: 'Dashboard loads',
            steps: [
              {
                index: 1,
                text: 'Open dashboard',
                screenshotPath: 'step-1.png',
              },
              { index: 2, text: 'Check widgets', screenshotPath: null },
            ],
            stoppedAtStep: null,
            stopReason: null,
          },
        ],
      }
      writeManifest(tmpDir, originId, manifest)
      const result = runCli(['arc', 'qa', originId], { MARS_REPO: tmpDir })
      expect(result.status).toBe(0)
      // The absolute path must include the arc-qa dir and the screenshot name
      expect(result.stdout).toMatch(
        new RegExp(`arc-qa[/\\\\]${originId}[/\\\\]step-1\\.png`),
      )
      // Step 2 has no screenshot — no extra path line
      const lines = result.stdout.split('\n')
      const step2LineIdx = lines.findIndex((l) => l.includes('2. Check widgets'))
      expect(step2LineIdx).toBeGreaterThan(-1)
      // The line immediately after step 2 should not be a path line for step-1.png
      const nextLine = lines[step2LineIdx + 1] ?? ''
      expect(nextLine).not.toContain('step-1.png')
    })
  })

  it('handles multiple criteria', () => {
    withTempRepo((tmpDir) => {
      const originId = 'arc-multi-001'
      const manifest: ArcQaManifest = {
        originId,
        generatedAt: Date.now(),
        criteria: [
          {
            criterion: 'First criterion',
            steps: [{ index: 1, text: 'Step A', screenshotPath: null }],
            stoppedAtStep: null,
            stopReason: null,
          },
          {
            criterion: 'Second criterion',
            steps: [{ index: 1, text: 'Step B', screenshotPath: null }],
            stoppedAtStep: null,
            stopReason: null,
          },
        ],
      }
      writeManifest(tmpDir, originId, manifest)
      const result = runCli(['arc', 'qa', originId], { MARS_REPO: tmpDir })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Criterion: First criterion')
      expect(result.stdout).toContain('Criterion: Second criterion')
    })
  })
})
