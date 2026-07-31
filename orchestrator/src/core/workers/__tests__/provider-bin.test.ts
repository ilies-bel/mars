import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROVIDER_BIN_ENV,
  checkProviderBin,
  describeMissingProviderBin,
  providerBinPath,
  resetProviderBinCache,
  resolveProviderBin,
} from '../provider-bin'
import { buildWorkerEnv } from '../../lib/git/claude'

let dir: string
const savedEnv = { ...process.env }

const makeExecutable = (parent: string, name: string): string => {
  const p = join(parent, name)
  writeFileSync(p, '#!/bin/sh\nexit 0\n')
  chmodSync(p, 0o755)
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mars-provider-bin-'))
  resetProviderBinCache()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  resetProviderBinCache()
})

describe('resolveProviderBin', () => {
  it('finds the binary on PATH', () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const codex = makeExecutable(bin, 'codex')
    process.env.PATH = bin
    delete process.env.MARS_CODEX_BIN

    const r = resolveProviderBin('codex')
    expect(r.path).toBe(codex)
    expect(r.override).toBeNull()
    expect(r.searchedDirs).toContain(bin)
  })

  it('honours an absolute env override', () => {
    const custom = makeExecutable(dir, 'codex-custom')
    process.env.MARS_CODEX_BIN = custom
    process.env.PATH = ''

    const r = resolveProviderBin('codex')
    expect(r.path).toBe(custom)
    expect(r.override).toBe(custom)
  })

  it('reports an absolute override that does not exist as unresolved', () => {
    process.env.MARS_CODEX_BIN = join(dir, 'nope')
    const r = resolveProviderBin('codex')
    expect(r.path).toBeNull()
  })

  it('reports an absolute override that exists but is not executable as unresolved', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const p = join(dir, 'not-exec')
    writeFileSync(p, 'x')
    chmodSync(p, 0o644)
    process.env.MARS_CODEX_BIN = p
    expect(resolveProviderBin('codex').path).toBeNull()
  })

  it('searches PATH for a bare-name override', () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const alt = makeExecutable(bin, 'codex-alt')
    process.env.PATH = bin
    process.env.MARS_CODEX_BIN = 'codex-alt'
    expect(resolveProviderBin('codex').path).toBe(alt)
  })

  it('returns null (never a bare name) when nothing resolves', () => {
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    delete process.env.MARS_CODEX_BIN
    // Pin the search space: the host's real /opt/homebrew/bin is in the POSIX
    // fallback list and would otherwise resolve a real codex.
    const r = resolveProviderBin('codex', { pathEnv: empty, fallbackDirs: [] })
    expect(r.path).toBeNull()
    expect(r.pathEnv).toBe(empty)
  })

  it('searches the POSIX fallback dirs after PATH', () => {
    const fallback = join(dir, 'fallback')
    mkdirSync(fallback)
    const codex = makeExecutable(fallback, 'codex')
    delete process.env.MARS_CODEX_BIN
    const r = resolveProviderBin('codex', {
      pathEnv: join(dir, 'nothing-here'),
      fallbackDirs: [fallback],
    })
    expect(r.path).toBe(codex)
  })

  it('covers every provider with an env var and a binary name', () => {
    expect(PROVIDER_BIN_ENV).toEqual({
      claude: 'MARS_CLAUDE_BIN',
      codex: 'MARS_CODEX_BIN',
      gemini: 'MARS_GEMINI_BIN',
    })
  })
})

describe('providerBinPath — resolve once, reuse', () => {
  it('caches the resolved path so a later PATH change cannot break spawns', () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const codex = makeExecutable(bin, 'codex')
    process.env.PATH = bin
    delete process.env.MARS_CODEX_BIN

    expect(providerBinPath('codex')).toBe(codex)

    // Operator (or a hook) clobbers PATH mid-session.
    process.env.PATH = '/nonexistent'
    expect(providerBinPath('codex')).toBe(codex)
  })

  it('falls back to the bare name so spawn can surface a clean ENOENT', () => {
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    delete process.env.MARS_CODEX_BIN
    expect(providerBinPath('codex', { pathEnv: empty, fallbackDirs: [] })).toBe('codex')
  })

  it('is warmed by a successful pre-flight', () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const codex = makeExecutable(bin, 'codex')
    process.env.PATH = bin
    delete process.env.MARS_CODEX_BIN

    expect(checkProviderBin('codex').ok).toBe(true)
    process.env.PATH = '/nonexistent'
    expect(providerBinPath('codex')).toBe(codex)
  })
})

describe('checkProviderBin — the daemon startup pre-flight', () => {
  it('passes when the binary resolves and names the resolved path', () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const codex = makeExecutable(bin, 'codex')
    process.env.PATH = bin
    delete process.env.MARS_CODEX_BIN

    const check = checkProviderBin('codex')
    expect(check.ok).toBe(true)
    expect(check.message).toContain(codex)
  })

  it('fails with a message naming the binary, the search, and the daemon PATH', () => {
    const empty = join(dir, 'empty')
    mkdirSync(empty)
    delete process.env.MARS_CODEX_BIN

    const check = checkProviderBin('codex', { pathEnv: empty, fallbackDirs: [] })
    expect(check.ok).toBe(false)
    expect(check.message).toContain("provider 'codex'")
    expect(check.message).toContain('MARS_CODEX_BIN')
    expect(check.message).toContain(empty)
    expect(check.message).toContain('Refusing to start')
  })

  it('renders "(empty)" rather than nothing for an empty inherited PATH', () => {
    delete process.env.MARS_GEMINI_BIN
    const r = resolveProviderBin('gemini', { pathEnv: '', fallbackDirs: [] })
    expect(describeMissingProviderBin(r)).toContain('(empty)')
  })
})

describe('buildWorkerEnv keeps binary resolution possible', () => {
  it('never strips PATH (the host-agent scrub must not break spawns)', () => {
    process.env.PATH = '/usr/bin:/bin'
    const env = buildWorkerEnv()
    expect(env.PATH).toBe('/usr/bin:/bin')
  })

  it('preserves the provider bin overrides it must not swallow', () => {
    process.env.MARS_CODEX_BIN = '/opt/homebrew/bin/codex'
    process.env.MARS_GEMINI_BIN = '/opt/homebrew/bin/gemini'
    process.env.MARS_CLAUDE_BIN = '/opt/homebrew/bin/claude'
    const env = buildWorkerEnv()
    expect(env.MARS_CODEX_BIN).toBe('/opt/homebrew/bin/codex')
    expect(env.MARS_GEMINI_BIN).toBe('/opt/homebrew/bin/gemini')
    expect(env.MARS_CLAUDE_BIN).toBe('/opt/homebrew/bin/claude')
  })

  it('still strips the host-agent identity vars it exists for', () => {
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_SESSION_ID = 'abc'
    process.env.MARS_REPO = '/somewhere'
    const env = buildWorkerEnv()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_SESSION_ID).toBeUndefined()
    expect(env.MARS_REPO).toBeUndefined()
  })
})
