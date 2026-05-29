/**
 * Tests for the cross-platform binary build script (scripts/build-binary.ts).
 *
 * Coverage strategy:
 *  - Pure functions (isValidTarget, getBinaryName, getBunTarget) are tested by
 *    direct import — no subprocess needed.
 *  - computeHexDigest / writeSha256Sidecar are tested against real temp files
 *    so the crypto path is fully exercised.
 *  - "fails loudly on unsupported target" is tested via spawnSync so the exit
 *    code and stderr are observable from outside the module.
 *  - Actual bun compilation is NOT exercised here (too slow, requires Bun
 *    at build time); acceptance criterion #2 (--version on binary) is
 *    verified by the post-build CI smoke-test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  SUPPORTED_TARGETS,
  type Target,
  getBinaryName,
  getBunTarget,
  isValidTarget,
  computeHexDigest,
  writeSha256Sidecar,
} from '../scripts/build-binary'

const here = dirname(fileURLToPath(import.meta.url))
// test/ → orchestrator/
const projectRoot = resolve(here, '..')
const scriptPath = resolve(projectRoot, 'scripts', 'build-binary.ts')
const tsxBin = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

describe('isValidTarget', () => {
  it('accepts every entry in SUPPORTED_TARGETS', () => {
    for (const t of SUPPORTED_TARGETS) {
      expect(isValidTarget(t), `expected ${t} to be valid`).toBe(true)
    }
  })

  it('accepts all five expected targets', () => {
    const expected = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'windows-x64',
    ]
    for (const t of expected) {
      expect(isValidTarget(t), `expected ${t} to be valid`).toBe(true)
    }
  })

  it('rejects an unsupported OS', () => {
    expect(isValidTarget('freebsd-x64')).toBe(false)
  })

  it('rejects an unsupported arch', () => {
    expect(isValidTarget('linux-arm32')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidTarget('')).toBe(false)
  })

  it('rejects a target with reversed order', () => {
    expect(isValidTarget('arm64-darwin')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Binary naming
// ---------------------------------------------------------------------------

describe('getBinaryName', () => {
  it.each([
    ['darwin-arm64', 'mars-darwin-arm64'],
    ['darwin-x64', 'mars-darwin-x64'],
    ['linux-arm64', 'mars-linux-arm64'],
    ['linux-x64', 'mars-linux-x64'],
  ])('%s → %s (no .exe extension)', (target, expected) => {
    expect(getBinaryName(target as Target)).toBe(expected)
  })

  it('appends .exe for windows-x64', () => {
    expect(getBinaryName('windows-x64')).toBe('mars-windows-x64.exe')
  })

  it('name is deterministic — calling twice returns the same string', () => {
    for (const t of SUPPORTED_TARGETS) {
      expect(getBinaryName(t as Target)).toBe(getBinaryName(t as Target))
    }
  })
})

// ---------------------------------------------------------------------------
// Bun compile target mapping
// ---------------------------------------------------------------------------

describe('getBunTarget', () => {
  it('prefixes the target string with "bun-"', () => {
    for (const t of SUPPORTED_TARGETS) {
      expect(getBunTarget(t as Target)).toBe(`bun-${t}`)
    }
  })
})

// ---------------------------------------------------------------------------
// SHA-256 digest computation
// ---------------------------------------------------------------------------

describe('computeHexDigest', () => {
  let scratch: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'mars-build-test-'))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('returns the correct sha256 hex for a known input', async () => {
    const content = 'hello, mars binary!'
    const file = join(scratch, 'hello.bin')
    await writeFile(file, content, 'utf8')

    // Reference value via Node crypto (same library, no shell-out).
    const expected = createHash('sha256').update(content, 'utf8').digest('hex')

    await expect(computeHexDigest(file)).resolves.toBe(expected)
  })

  it('returns a 64-character lowercase hex string', async () => {
    const file = join(scratch, 'random.bin')
    await writeFile(file, 'some content', 'utf8')
    const hex = await computeHexDigest(file)
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// SHA-256 sidecar creation
// ---------------------------------------------------------------------------

describe('writeSha256Sidecar', () => {
  let scratch: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'mars-sidecar-test-'))
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('creates a .sha256 file next to the binary', async () => {
    const binaryPath = join(scratch, 'mars-linux-x64')
    await writeFile(binaryPath, 'fake binary content', 'utf8')

    await writeSha256Sidecar(binaryPath)

    const sidecar = join(scratch, 'mars-linux-x64.sha256')
    const content = await readFile(sidecar, 'utf8')
    expect(content).toBeTruthy()
  })

  it('sidecar contains the correct hex digest', async () => {
    const content = 'another fake binary'
    const binaryPath = join(scratch, 'mars-darwin-arm64')
    await writeFile(binaryPath, content, 'utf8')

    await writeSha256Sidecar(binaryPath)

    const sidecar = await readFile(`${binaryPath}.sha256`, 'utf8')
    const expectedHex = createHash('sha256').update(content, 'utf8').digest('hex')
    expect(sidecar).toContain(expectedHex)
  })

  it('sidecar contains the binary filename', async () => {
    const binaryPath = join(scratch, 'mars-windows-x64.exe')
    await writeFile(binaryPath, 'windows binary', 'utf8')

    await writeSha256Sidecar(binaryPath)

    const sidecar = await readFile(`${binaryPath}.sha256`, 'utf8')
    expect(sidecar).toContain('mars-windows-x64.exe')
  })

  it('sidecar ends with a newline', async () => {
    const binaryPath = join(scratch, 'mars-linux-arm64')
    await writeFile(binaryPath, 'linux arm64 binary', 'utf8')

    await writeSha256Sidecar(binaryPath)

    const sidecar = await readFile(`${binaryPath}.sha256`, 'utf8')
    expect(sidecar.endsWith('\n')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Script entry-point: loud failure on unsupported target
// ---------------------------------------------------------------------------

describe('build-binary script — unsupported target', () => {
  it('exits non-zero and writes an error to stderr', () => {
    const result = spawnSync(
      process.execPath,
      [tsxBin, scriptPath, 'freebsd-mips64'],
      { encoding: 'utf8' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unsupported target')
    expect(result.stderr).toContain('freebsd-mips64')
  })

  it('lists supported targets in the error message', () => {
    const result = spawnSync(
      process.execPath,
      [tsxBin, scriptPath, 'plan9-x64'],
      { encoding: 'utf8' },
    )

    expect(result.status).not.toBe(0)
    for (const t of SUPPORTED_TARGETS) {
      expect(result.stderr).toContain(t)
    }
  })

  it('exits non-zero when no target is supplied', () => {
    const result = spawnSync(process.execPath, [tsxBin, scriptPath], {
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unsupported target')
  })
})
