import { describe, expect, it } from 'vitest'
import { classifyInstallRoute, PROD_BINARY_MIN_BYTES } from './install-route'

describe('classifyInstallRoute', () => {
  // ── DEV install (tsx wrapper) ──────────────────────────────────────────────
  //
  // install-dev.sh writes a small shell shim that executes:
  //   exec "$TSX_BIN" "$ENTRY" "$@"
  // where ENTRY is the TypeScript source file (orchestrator/src/cli.ts).
  // The shim itself is a few hundred bytes; process.argv[1] ends in .ts.

  describe('dev install (tsx wrapper)', () => {
    it('returns dev when argv1 ends with .ts (running from source via tsx)', () => {
      const result = classifyInstallRoute({
        argv1: '/home/dev/mars-framework/orchestrator/src/cli.ts',
        execPath: '/home/dev/mars-framework/orchestrator/node_modules/.bin/tsx',
        statSize: () => 512,
      })
      expect(result).toBe('dev')
    })

    it('returns dev for a deeper argv1 path that still ends with .ts', () => {
      const result = classifyInstallRoute({
        argv1: '/Users/alice/projects/mars-framework/orchestrator/src/cli.ts',
        execPath: '/Users/alice/.local/share/bun/bin/bun',
        statSize: () => 640,
      })
      expect(result).toBe('dev')
    })

    it('returns dev when execPath points to a small shell shim (not a compiled binary)', () => {
      // argv1 has no .ts extension — looks superficially like prod.
      // The file-size heuristic must catch this: 400 bytes is clearly a shim.
      const result = classifyInstallRoute({
        argv1: '/usr/local/bin/mars',
        execPath: '/usr/local/bin/mars',
        statSize: () => 400,
      })
      expect(result).toBe('dev')
    })

    it('returns dev when stat fails (executable is not readable or hidden)', () => {
      const result = classifyInstallRoute({
        argv1: '/usr/local/bin/mars',
        execPath: '/usr/local/bin/mars',
        statSize: () => null,
      })
      expect(result).toBe('dev')
    })

    it('returns dev when argv1 is undefined (argv has fewer than two entries)', () => {
      const result = classifyInstallRoute({
        argv1: undefined,
        execPath: '/usr/local/bin/mars',
        statSize: () => null,
      })
      expect(result).toBe('dev')
    })

    it('returns dev when argv1 is an empty string', () => {
      const result = classifyInstallRoute({
        argv1: '',
        execPath: '/usr/local/bin/mars',
        statSize: () => 256,
      })
      expect(result).toBe('dev')
    })
  })

  // ── PROD install (compiled Bun standalone binary) ─────────────────────────
  //
  // The release bootstrap places a compiled Bun binary on PATH. It bundles
  // the full Bun runtime plus all TypeScript, making it several MiB. There
  // is no .ts entry point and the binary is far above the 1 MiB floor.

  describe('prod install (compiled Bun binary)', () => {
    it('returns prod when execPath is a large compiled binary (~8 MiB)', () => {
      const result = classifyInstallRoute({
        argv1: '/usr/local/bin/mars',
        execPath: '/usr/local/bin/mars',
        statSize: () => 8_000_000,
      })
      expect(result).toBe('prod')
    })

    it('returns prod for a binary exactly at the 1 MiB threshold', () => {
      const result = classifyInstallRoute({
        argv1: '/home/runner/.local/bin/mars',
        execPath: '/home/runner/.local/bin/mars',
        statSize: () => PROD_BINARY_MIN_BYTES,
      })
      expect(result).toBe('prod')
    })

    it('returns prod when the binary is on a non-standard PATH location', () => {
      const result = classifyInstallRoute({
        argv1: '/opt/homebrew/bin/mars',
        execPath: '/opt/homebrew/bin/mars',
        statSize: () => 12_500_000,
      })
      expect(result).toBe('prod')
    })
  })

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('source-entry signal (argv1 ends in .ts) beats the size signal', () => {
      // Unusual: someone runs tsx against a bundle that happens to be named .ts,
      // while the bun runtime itself is large. The .ts signal wins because a
      // compiled prod binary never has a TypeScript entry.
      const result = classifyInstallRoute({
        argv1: '/tmp/bundle.ts',
        execPath: '/usr/bin/bun',
        statSize: () => 50_000_000, // bun runtime binary is huge
      })
      expect(result).toBe('dev')
    })

    it('returns dev when the binary is 1 byte below the 1 MiB floor', () => {
      const result = classifyInstallRoute({
        argv1: '/usr/local/bin/mars',
        execPath: '/usr/local/bin/mars',
        statSize: () => PROD_BINARY_MIN_BYTES - 1,
      })
      expect(result).toBe('dev')
    })

    it('returns dev when execPath is the empty string and stat fails', () => {
      const result = classifyInstallRoute({
        argv1: '/usr/local/bin/mars',
        execPath: '',
        statSize: () => null,
      })
      expect(result).toBe('dev')
    })
  })
})
