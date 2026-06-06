import { describe, it, expect, vi } from 'vitest'
import {
  performSelfUpdate,
  SelfUpdateError,
  SELF_UPDATE_ERRORS,
  parseSidecarDigest,
  sha256hex,
  currentBinaryName,
  buildBinaryUrl,
  buildSidecarUrl,
  type SelfUpdateDeps,
} from './self-update'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeBuffer = (content: string): Buffer => Buffer.from(content, 'utf8')

/** sha256sum-format sidecar for a given buffer */
const makeSidecar = (data: Buffer, filename = 'mars-darwin-arm64'): string =>
  `${sha256hex(data)}  ${filename}\n`

/** A fully-happy-path deps stub. All file-system and network ops are no-ops. */
const makeDeps = (overrides: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps => {
  const binaryData = makeBuffer('fake binary content v2')
  return {
    installRoute: () => 'prod',
    inFlightCount: () => 0,
    readUpdateCache: async () => ({ latest: '1.2.3', available: true }),
    fetchBuffer: async () => binaryData,
    fetchText: async () => makeSidecar(binaryData),
    execPath: () => '/usr/local/bin/mars',
    buildBinaryUrl: (v) => `https://example.com/releases/v${v}/mars-darwin-arm64`,
    buildSidecarUrl: (v) => `https://example.com/releases/v${v}/mars-darwin-arm64.sha256`,
    rename: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    restartDaemon: vi.fn(async () => {}),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Unit tests: pure helpers
// ---------------------------------------------------------------------------

describe('parseSidecarDigest', () => {
  it('parses a well-formed sha256sum line', () => {
    const digest = 'a'.repeat(64)
    expect(parseSidecarDigest(`${digest}  mars-darwin-arm64\n`)).toBe(digest)
  })

  it('normalises hex to lowercase', () => {
    const digest = 'A'.repeat(64)
    expect(parseSidecarDigest(`${digest}  mars-darwin-arm64\n`)).toBe(
      'a'.repeat(64),
    )
  })

  it('returns null when the digest is too short', () => {
    expect(parseSidecarDigest('abc123  mars-darwin-arm64')).toBeNull()
  })

  it('returns null for empty content', () => {
    expect(parseSidecarDigest('')).toBeNull()
    expect(parseSidecarDigest('   ')).toBeNull()
  })

  it('returns null when the first token contains non-hex characters', () => {
    expect(parseSidecarDigest(`${'g'.repeat(64)}  file`)).toBeNull()
  })
})

describe('currentBinaryName', () => {
  it('names macOS arm64 binary correctly', () => {
    expect(currentBinaryName('darwin', 'arm64')).toBe('mars-darwin-arm64')
  })

  it('names Linux x64 binary correctly', () => {
    expect(currentBinaryName('linux', 'x64')).toBe('mars-linux-x64')
  })

  it('names Windows x64 binary with .exe suffix', () => {
    expect(currentBinaryName('win32', 'x64')).toBe('mars-windows-x64.exe')
  })
})

describe('buildBinaryUrl / buildSidecarUrl', () => {
  it('constructs the GitHub download URL for the binary', () => {
    expect(buildBinaryUrl('0.4.2')).toContain('/v0.4.2/')
    expect(buildBinaryUrl('0.4.2')).toContain('github.com')
  })

  it('sidecar URL is the binary URL with .sha256 appended', () => {
    const binaryUrl = buildBinaryUrl('0.4.2')
    expect(buildSidecarUrl('0.4.2')).toBe(`${binaryUrl}.sha256`)
  })
})

// ---------------------------------------------------------------------------
// Integration-style tests: performSelfUpdate
// ---------------------------------------------------------------------------

describe('performSelfUpdate — gate: dev install refusal', () => {
  it('throws SelfUpdateError DEV_INSTALL when install route is dev', async () => {
    const deps = makeDeps({ installRoute: () => 'dev' })

    await expect(performSelfUpdate(deps)).rejects.toMatchObject({
      name: 'SelfUpdateError',
      code: SELF_UPDATE_ERRORS.DEV_INSTALL,
    })
  })

  it('does NOT call rename or restartDaemon on dev install rejection', async () => {
    const deps = makeDeps({ installRoute: () => 'dev' })

    await expect(performSelfUpdate(deps)).rejects.toThrow()
    expect(deps.rename).not.toHaveBeenCalled()
    expect(deps.restartDaemon).not.toHaveBeenCalled()
  })
})

describe('performSelfUpdate — gate: tasks in flight', () => {
  it('throws SelfUpdateError TASKS_IN_FLIGHT when any task is running', async () => {
    const deps = makeDeps({ inFlightCount: () => 2 })

    await expect(performSelfUpdate(deps)).rejects.toMatchObject({
      name: 'SelfUpdateError',
      code: SELF_UPDATE_ERRORS.TASKS_IN_FLIGHT,
    })
  })

  it('includes the count in the error message', async () => {
    const deps = makeDeps({ inFlightCount: () => 3 })

    await expect(performSelfUpdate(deps)).rejects.toThrow('3 tasks are in flight')
  })

  it('does NOT rename or restart when tasks are in flight', async () => {
    const deps = makeDeps({ inFlightCount: () => 1 })

    await expect(performSelfUpdate(deps)).rejects.toThrow()
    expect(deps.rename).not.toHaveBeenCalled()
    expect(deps.restartDaemon).not.toHaveBeenCalled()
  })
})

describe('performSelfUpdate — gate: no update available', () => {
  it('throws NO_UPDATE_AVAILABLE when cache says available=false', async () => {
    const deps = makeDeps({
      readUpdateCache: async () => ({ latest: '1.0.0', available: false }),
    })

    await expect(performSelfUpdate(deps)).rejects.toMatchObject({
      code: SELF_UPDATE_ERRORS.NO_UPDATE_AVAILABLE,
    })
  })

  it('throws NO_UPDATE_AVAILABLE when cache is null', async () => {
    const deps = makeDeps({ readUpdateCache: async () => null })

    await expect(performSelfUpdate(deps)).rejects.toMatchObject({
      code: SELF_UPDATE_ERRORS.NO_UPDATE_AVAILABLE,
    })
  })
})

describe('performSelfUpdate — sha256 mismatch', () => {
  it('throws SHA256_MISMATCH when digest does not match', async () => {
    const realData = makeBuffer('correct binary data')
    const tamperedData = makeBuffer('tampered binary data')

    const deps = makeDeps({
      // sidecar was computed for realData, but we downloaded tamperedData
      fetchBuffer: async () => tamperedData,
      fetchText: async () => makeSidecar(realData),
    })

    await expect(performSelfUpdate(deps)).rejects.toMatchObject({
      code: SELF_UPDATE_ERRORS.SHA256_MISMATCH,
    })
  })

  it('does NOT rename or write any files when sha256 mismatches', async () => {
    const realData = makeBuffer('correct binary data')
    const tamperedData = makeBuffer('tampered binary data')

    const deps = makeDeps({
      fetchBuffer: async () => tamperedData,
      fetchText: async () => makeSidecar(realData),
    })

    await expect(performSelfUpdate(deps)).rejects.toThrow()
    // rename must not be called — existing binary must be untouched
    expect(deps.rename).not.toHaveBeenCalled()
    expect(deps.writeFile).not.toHaveBeenCalled()
  })

  it('throws SHA256_MISMATCH when the sidecar is malformed', async () => {
    const deps = makeDeps({
      fetchText: async () => 'not-a-valid-digest  file\n',
    })

    await expect(performSelfUpdate(deps)).rejects.toMatchObject({
      code: SELF_UPDATE_ERRORS.SHA256_MISMATCH,
    })
    expect(deps.rename).not.toHaveBeenCalled()
  })
})

describe('performSelfUpdate — download failure', () => {
  it('throws DOWNLOAD_FAILED when the binary fetch rejects', async () => {
    const deps = makeDeps({
      fetchBuffer: async () => {
        throw new Error('network error')
      },
    })

    await expect(performSelfUpdate(deps)).rejects.toMatchObject({
      code: SELF_UPDATE_ERRORS.DOWNLOAD_FAILED,
    })
  })

  it('throws DOWNLOAD_FAILED when the sidecar fetch rejects', async () => {
    const deps = makeDeps({
      fetchText: async () => {
        throw new Error('404 Not Found')
      },
    })

    await expect(performSelfUpdate(deps)).rejects.toMatchObject({
      code: SELF_UPDATE_ERRORS.DOWNLOAD_FAILED,
    })
    expect(deps.rename).not.toHaveBeenCalled()
  })
})

describe('performSelfUpdate — happy path', () => {
  it('writes the new binary, swaps it atomically, and re-execs', async () => {
    const deps = makeDeps()

    await performSelfUpdate(deps)

    // staged binary was written
    expect(deps.writeFile).toHaveBeenCalledOnce()
    const stagingPath = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(stagingPath).toContain('/usr/local/bin/mars')

    // atomic swap: current → .bak, then staging → current
    expect(deps.rename).toHaveBeenCalledTimes(2)
    const renameCalls = (deps.rename as ReturnType<typeof vi.fn>).mock.calls
    expect(renameCalls[0]).toEqual(['/usr/local/bin/mars', '/usr/local/bin/mars.bak'])
    expect(renameCalls[1]).toEqual([stagingPath, '/usr/local/bin/mars'])

    // daemon was re-execed
    expect(deps.restartDaemon).toHaveBeenCalledOnce()
  })

  it('uses the version from the update cache in the download URL', async () => {
    const fetchBuffer = vi.fn(async (url: string) => {
      const binaryData = makeBuffer('binary v1.9.9')
      return binaryData
    })
    const fetchText = vi.fn(async (url: string) => {
      // We need to return a sidecar that matches the binaryData
      // Since fetchBuffer always returns the same mock, we just use a matching sidecar
      const binaryData = makeBuffer('binary v1.9.9')
      return makeSidecar(binaryData)
    })

    const deps = makeDeps({
      readUpdateCache: async () => ({ latest: '1.9.9', available: true }),
      fetchBuffer,
      fetchText,
    })

    await performSelfUpdate(deps)

    expect(fetchBuffer).toHaveBeenCalledWith(expect.stringContaining('1.9.9'))
    expect(fetchText).toHaveBeenCalledWith(expect.stringContaining('1.9.9'))
  })
})
