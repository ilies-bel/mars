import { describe, it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runInstall } from './install.js'
import type { InstallDeps, Manifest } from './install.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_MANIFEST: Manifest = {
  schemaVersion: 1,
  owned: [],
  hybrid: [],
  scopes: [],
}

const FULL_MANIFEST: Manifest = {
  schemaVersion: 1,
  owned: [
    '.claude/plugin.json',
    '.claude/hooks/run-checks.sh',
    '.claude/agents/vcs-supervisor.md',
  ],
  hybrid: [
    'CLAUDE.md',
    '.claude/settings.json',
  ],
  scopes: [],
}

// ---------------------------------------------------------------------------
// Test deps factory (in-memory)
// ---------------------------------------------------------------------------

interface TestInstallDeps extends InstallDeps {
  written: Map<string, { content: Buffer; mode?: number }>
  logged: string[]
  existingPaths: Set<string>
  sourceFiles: Map<string, Buffer>
}

function makeDeps(
  opts: {
    existingPaths?: Set<string>
    sourceFiles?: Map<string, Buffer>
  } = {},
): TestInstallDeps {
  const written = new Map<string, { content: Buffer; mode?: number }>()
  const logged: string[] = []
  const existingPaths = opts.existingPaths ?? new Set<string>()
  const sourceFiles = opts.sourceFiles ?? new Map<string, Buffer>()

  return {
    written,
    logged,
    existingPaths,
    sourceFiles,
    readBytes(srcPath: string): Buffer {
      const content = sourceFiles.get(srcPath)
      if (content === undefined) {
        throw new Error(`readBytes: no fixture for ${srcPath}`)
      }
      return content
    },
    writeFile(dstPath: string, content: Buffer, mode?: number): void {
      written.set(dstPath, { content, mode })
    },
    exists(path: string): boolean {
      return existingPaths.has(path)
    },
    log(msg: string): void {
      logged.push(msg)
    },
  }
}

/** Populate source files for every path in the manifest (framework root = '/fw'). */
function withManifestSources(
  deps: TestInstallDeps,
  manifest: Manifest,
  frameworkRoot = '/fw',
): void {
  for (const relPath of [...manifest.owned, ...manifest.hybrid]) {
    deps.sourceFiles.set(join(frameworkRoot, relPath), Buffer.from(`content of ${relPath}`))
  }
}

const FRAMEWORK_ROOT = '/fw'
const CONSUMER_ROOT = '/consumer'
const MARS_VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// Tracer bullet — minimal manifest succeeds
// ---------------------------------------------------------------------------

describe('runInstall — minimal manifest', () => {
  it('returns success outcome on a clean repo with an empty manifest', async () => {
    const deps = makeDeps()
    const result = await runInstall(MINIMAL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)
    expect(result.outcome).toBe('success')
  })

  it('always writes mars.lock even when manifest has no files', async () => {
    const deps = makeDeps()
    await runInstall(MINIMAL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)
    expect(deps.written.has(join(CONSUMER_ROOT, 'mars.lock'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Owned files
// ---------------------------------------------------------------------------

describe('runInstall — owned files', () => {
  it('writes every owned file to the consumer root', async () => {
    const deps = makeDeps()
    withManifestSources(deps, FULL_MANIFEST)
    await runInstall(FULL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    for (const relPath of FULL_MANIFEST.owned) {
      const dstPath = join(CONSUMER_ROOT, relPath)
      expect(deps.written.has(dstPath), `expected ${dstPath} to be written`).toBe(true)
    }
  })

  it('writes the correct bytes from the source file', async () => {
    const manifest: Manifest = { schemaVersion: 1, owned: ['.claude/plugin.json'], hybrid: [], scopes: [] }
    const expectedBytes = Buffer.from('{"plugin":"data"}')
    const deps = makeDeps({
      sourceFiles: new Map([[join(FRAMEWORK_ROOT, '.claude/plugin.json'), expectedBytes]]),
    })
    await runInstall(manifest, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const written = deps.written.get(join(CONSUMER_ROOT, '.claude/plugin.json'))
    expect(written?.content).toEqual(expectedBytes)
  })

  it('marks .sh owned files as executable (mode 0o755)', async () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      owned: ['.claude/hooks/run-checks.sh'],
      hybrid: [],
      scopes: [],
    }
    const deps = makeDeps({
      sourceFiles: new Map([[join(FRAMEWORK_ROOT, '.claude/hooks/run-checks.sh'), Buffer.from('#!/bin/bash')]]),
    })
    await runInstall(manifest, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const written = deps.written.get(join(CONSUMER_ROOT, '.claude/hooks/run-checks.sh'))
    expect(written?.mode).toBe(0o755)
  })

  it('does NOT mark non-executable owned files with mode 0o755', async () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      owned: ['.claude/plugin.json'],
      hybrid: [],
      scopes: [],
    }
    const deps = makeDeps({
      sourceFiles: new Map([[join(FRAMEWORK_ROOT, '.claude/plugin.json'), Buffer.from('{}')]]),
    })
    await runInstall(manifest, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const written = deps.written.get(join(CONSUMER_ROOT, '.claude/plugin.json'))
    expect(written?.mode).toBeUndefined()
  })

  it('overwrites an owned file that already exists', async () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      owned: ['.claude/plugin.json'],
      hybrid: [],
      scopes: [],
    }
    const newBytes = Buffer.from('new content')
    const deps = makeDeps({
      existingPaths: new Set([join(CONSUMER_ROOT, '.claude/plugin.json')]),
      sourceFiles: new Map([[join(FRAMEWORK_ROOT, '.claude/plugin.json'), newBytes]]),
    })
    await runInstall(manifest, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const written = deps.written.get(join(CONSUMER_ROOT, '.claude/plugin.json'))
    expect(written?.content).toEqual(newBytes)
  })
})

// ---------------------------------------------------------------------------
// Hybrid files
// ---------------------------------------------------------------------------

describe('runInstall — hybrid files (clean repo)', () => {
  it('writes every hybrid file when none exist', async () => {
    const deps = makeDeps()
    withManifestSources(deps, FULL_MANIFEST)
    await runInstall(FULL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    for (const relPath of FULL_MANIFEST.hybrid) {
      const dstPath = join(CONSUMER_ROOT, relPath)
      expect(deps.written.has(dstPath), `expected ${dstPath} to be written`).toBe(true)
    }
  })

  it('skips a hybrid file that already exists', async () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      owned: [],
      hybrid: ['CLAUDE.md'],
      scopes: [],
    }
    const deps = makeDeps({
      existingPaths: new Set([join(CONSUMER_ROOT, 'CLAUDE.md')]),
      sourceFiles: new Map([[join(FRAMEWORK_ROOT, 'CLAUDE.md'), Buffer.from('# new')]]),
    })
    await runInstall(manifest, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    expect(deps.written.has(join(CONSUMER_ROOT, 'CLAUDE.md'))).toBe(false)
  })

  it('logs a skip message for an existing hybrid file', async () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      owned: [],
      hybrid: ['CLAUDE.md'],
      scopes: [],
    }
    const deps = makeDeps({
      existingPaths: new Set([join(CONSUMER_ROOT, 'CLAUDE.md')]),
      sourceFiles: new Map([[join(FRAMEWORK_ROOT, 'CLAUDE.md'), Buffer.from('# new')]]),
    })
    await runInstall(manifest, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const skipped = deps.logged.some((msg) => /skip.*CLAUDE\.md/i.test(msg))
    expect(skipped).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// mars.lock
// ---------------------------------------------------------------------------

describe('runInstall — mars.lock', () => {
  it('writes mars.lock at the consumer root', async () => {
    const deps = makeDeps()
    withManifestSources(deps, FULL_MANIFEST)
    await runInstall(FULL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const lockPath = join(CONSUMER_ROOT, 'mars.lock')
    expect(deps.written.has(lockPath)).toBe(true)
  })

  it('mars.lock contains the mars version', async () => {
    const deps = makeDeps()
    await runInstall(MINIMAL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, '1.2.3', deps)

    const lockPath = join(CONSUMER_ROOT, 'mars.lock')
    const raw = deps.written.get(lockPath)!.content.toString('utf8')
    const lock = JSON.parse(raw)
    expect(lock.marsVersion).toBe('1.2.3')
  })

  it('mars.lock has mode = prod', async () => {
    const deps = makeDeps()
    await runInstall(MINIMAL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const lockPath = join(CONSUMER_ROOT, 'mars.lock')
    const raw = deps.written.get(lockPath)!.content.toString('utf8')
    const lock = JSON.parse(raw)
    expect(lock.mode).toBe('prod')
  })

  it('mars.lock has installedAt ISO timestamp', async () => {
    const deps = makeDeps()
    await runInstall(MINIMAL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const lockPath = join(CONSUMER_ROOT, 'mars.lock')
    const raw = deps.written.get(lockPath)!.content.toString('utf8')
    const lock = JSON.parse(raw)
    expect(typeof lock.installedAt).toBe('string')
    expect(() => new Date(lock.installedAt).toISOString()).not.toThrow()
  })

  it('mars.lock lists all written files', async () => {
    const deps = makeDeps()
    withManifestSources(deps, FULL_MANIFEST)
    await runInstall(FULL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const lockPath = join(CONSUMER_ROOT, 'mars.lock')
    const raw = deps.written.get(lockPath)!.content.toString('utf8')
    const lock = JSON.parse(raw)
    const writtenPaths = lock.files.map((f: { path: string }) => f.path)

    for (const relPath of [...FULL_MANIFEST.owned, ...FULL_MANIFEST.hybrid]) {
      expect(writtenPaths).toContain(relPath)
    }
  })

  it('mars.lock records each file\'s kind (owned or hybrid)', async () => {
    const deps = makeDeps()
    withManifestSources(deps, FULL_MANIFEST)
    await runInstall(FULL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const lockPath = join(CONSUMER_ROOT, 'mars.lock')
    const raw = deps.written.get(lockPath)!.content.toString('utf8')
    const lock = JSON.parse(raw)

    for (const entry of lock.files as Array<{ path: string; kind: string }>) {
      expect(['owned', 'hybrid']).toContain(entry.kind)
    }
  })

  it('mars.lock does not include skipped hybrid files', async () => {
    const manifest: Manifest = {
      schemaVersion: 1,
      owned: [],
      hybrid: ['CLAUDE.md'],
      scopes: [],
    }
    const deps = makeDeps({
      existingPaths: new Set([join(CONSUMER_ROOT, 'CLAUDE.md')]),
      sourceFiles: new Map([[join(FRAMEWORK_ROOT, 'CLAUDE.md'), Buffer.from('# x')]]),
    })
    await runInstall(manifest, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const lockPath = join(CONSUMER_ROOT, 'mars.lock')
    const raw = deps.written.get(lockPath)!.content.toString('utf8')
    const lock = JSON.parse(raw)
    expect(lock.files.map((f: { path: string }) => f.path)).not.toContain('CLAUDE.md')
  })

  it('mars.lock schemaVersion matches the manifest schemaVersion', async () => {
    const deps = makeDeps()
    await runInstall(MINIMAL_MANIFEST, FRAMEWORK_ROOT, CONSUMER_ROOT, MARS_VERSION, deps)

    const lockPath = join(CONSUMER_ROOT, 'mars.lock')
    const raw = deps.written.get(lockPath)!.content.toString('utf8')
    const lock = JSON.parse(raw)
    expect(lock.schemaVersion).toBe(MINIMAL_MANIFEST.schemaVersion)
  })
})

// ---------------------------------------------------------------------------
// Integration test — real filesystem (temp dirs)
// ---------------------------------------------------------------------------

describe('runInstall — real filesystem integration', () => {
  it('copies files to the consumer dir and creates a readable mars.lock', async () => {
    const fwDir = mkdtempSync(join(tmpdir(), 'mars-install-fw-'))
    const consumerDir = mkdtempSync(join(tmpdir(), 'mars-install-consumer-'))

    try {
      // Set up a small mock framework tree
      const manifest: Manifest = {
        schemaVersion: 1,
        owned: ['.claude/plugin.json', '.claude/hooks/check.sh'],
        hybrid: ['CLAUDE.md'],
        scopes: [],
      }

      // Create source files in the mock framework dir
      mkdirSync(join(fwDir, '.claude', 'hooks'), { recursive: true })
      writeFileSync(join(fwDir, '.claude', 'plugin.json'), '{"plugin":"test"}')
      writeFileSync(join(fwDir, '.claude', 'hooks', 'check.sh'), '#!/bin/bash\necho ok', {
        mode: 0o755,
      })
      writeFileSync(join(fwDir, 'CLAUDE.md'), '# Test CLAUDE.md')

      // Real deps using top-level imports
      const realDeps: InstallDeps = {
        readBytes(srcPath: string): Buffer {
          return readFileSync(srcPath)
        },
        writeFile(dstPath: string, content: Buffer, mode?: number): void {
          mkdirSync(dirname(dstPath), { recursive: true })
          writeFileSync(dstPath, content, mode !== undefined ? { mode } : {})
        },
        exists(path: string): boolean {
          return existsSync(path)
        },
        log(_msg: string): void {
          // no-op in integration test
        },
      }

      const result = await runInstall(manifest, fwDir, consumerDir, '0.1.0', realDeps)

      // outcome
      expect(result.outcome).toBe('success')

      // owned files exist
      expect(existsSync(join(consumerDir, '.claude', 'plugin.json'))).toBe(true)
      expect(existsSync(join(consumerDir, '.claude', 'hooks', 'check.sh'))).toBe(true)

      // hybrid file written (was absent)
      expect(existsSync(join(consumerDir, 'CLAUDE.md'))).toBe(true)

      // .sh file is executable
      const shMode = statSync(join(consumerDir, '.claude', 'hooks', 'check.sh')).mode
      expect(shMode & 0o111).not.toBe(0) // at least one exec bit set

      // mars.lock exists and parses
      const lockPath = join(consumerDir, 'mars.lock')
      expect(existsSync(lockPath)).toBe(true)
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
      expect(lock.marsVersion).toBe('0.1.0')
      expect(lock.mode).toBe('prod')
      expect(Array.isArray(lock.files)).toBe(true)
      expect(lock.files.length).toBe(3) // all 3 files written
    } finally {
      rmSync(fwDir, { recursive: true, force: true })
      rmSync(consumerDir, { recursive: true, force: true })
    }
  })
})
