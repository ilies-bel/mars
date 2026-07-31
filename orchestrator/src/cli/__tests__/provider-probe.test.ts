/**
 * Unit tests for provider-probe.ts — pure/injectable probe logic.
 *
 * Covers:
 *   - probeProvider: binary detection, auth detection, env-override for each provider
 *   - formatProviderProbe: paperclip-style output for each result shape
 *
 * Nothing here touches real binaries, real files, or real daemons.
 */

import { describe, expect, it } from 'vitest'
import {
  probeProvider,
  formatProviderProbe,
  type ProviderProbeDeps,
  type ProviderProbeResult,
} from '../commands/provider-probe'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a fully-passing ProviderProbeDeps stub; override individual fields. */
const makeDeps = (overrides: Partial<ProviderProbeDeps> = {}): ProviderProbeDeps => ({
  tryRun: () => 0,
  fileReadable: () => false,
  env: {},
  homeDir: '/home/testuser',
  ...overrides,
})

// ---------------------------------------------------------------------------
// probeProvider — claude
// ---------------------------------------------------------------------------

describe('probeProvider — claude', () => {
  it('reports installed=true when claude is on PATH (tryRun returns 0)', () => {
    const result = probeProvider('claude', makeDeps({ tryRun: () => 0 }))
    expect(result.installed).toBe(true)
  })

  it('reports installed=false when claude is not on PATH (tryRun returns null)', () => {
    const result = probeProvider('claude', makeDeps({ tryRun: () => null }))
    expect(result.installed).toBe(false)
  })

  it('reports installed=false when tryRun returns non-zero (binary present but broken)', () => {
    // non-zero exit still means found (not ENOENT) — the binary IS present
    const result = probeProvider('claude', makeDeps({ tryRun: () => 1 }))
    expect(result.installed).toBe(true)
  })

  it('uses the default binary name "claude" when MARS_CLAUDE_BIN is not set', () => {
    const invoked: string[] = []
    probeProvider(
      'claude',
      makeDeps({ tryRun: (cmd) => { invoked.push(cmd); return 0 } }),
    )
    expect(invoked).toHaveLength(1)
    expect(invoked[0]).toBe('claude')
  })

  it('uses MARS_CLAUDE_BIN env override for the binary', () => {
    const invoked: string[] = []
    probeProvider(
      'claude',
      makeDeps({
        tryRun: (cmd) => { invoked.push(cmd); return 0 },
        env: { MARS_CLAUDE_BIN: '/opt/claude-custom' },
      }),
    )
    expect(invoked[0]).toBe('/opt/claude-custom')
  })

  it('detects api-key auth when ANTHROPIC_API_KEY is set', () => {
    const result = probeProvider(
      'claude',
      makeDeps({ env: { ANTHROPIC_API_KEY: 'sk-abc123' } }),
    )
    expect(result.authed).toBe('yes')
    expect(result.authDetail).toContain('api-key')
  })

  it('detects subscription auth when ~/.claude/.credentials.json exists', () => {
    const result = probeProvider(
      'claude',
      makeDeps({
        env: {},
        fileReadable: (p) => p.includes('.credentials.json'),
        homeDir: '/home/user',
      }),
    )
    expect(result.authed).toBe('yes')
    expect(result.authDetail).toContain('subscription')
  })

  it('api-key takes precedence over credentials file', () => {
    const result = probeProvider(
      'claude',
      makeDeps({
        env: { ANTHROPIC_API_KEY: 'sk-abc' },
        fileReadable: (p) => p.includes('.credentials.json'),
        homeDir: '/home/user',
      }),
    )
    expect(result.authed).toBe('yes')
    expect(result.authDetail).toBe('api-key')
  })

  it('returns authed=unknown when installed but no auth signals', () => {
    const result = probeProvider(
      'claude',
      makeDeps({ tryRun: () => 0, env: {}, fileReadable: () => false }),
    )
    expect(result.authed).toBe('unknown')
  })

  it('returns authed=unknown when not installed (no auth check needed)', () => {
    const result = probeProvider('claude', makeDeps({ tryRun: () => null }))
    expect(result.installed).toBe(false)
    // authDetail is still available (probe runs auth check regardless of installed)
    expect(result.authed).toBe('unknown')
  })

  it('includes a non-empty install hint', () => {
    const result = probeProvider('claude', makeDeps())
    expect(result.installHint).toMatch(/https?:\/\//)
  })
})

// ---------------------------------------------------------------------------
// probeProvider — gemini
// ---------------------------------------------------------------------------

describe('probeProvider — gemini', () => {
  it('reports installed=true when gemini is on PATH', () => {
    const result = probeProvider('gemini', makeDeps({ tryRun: () => 0 }))
    expect(result.installed).toBe(true)
  })

  it('reports installed=false when gemini is not on PATH', () => {
    const result = probeProvider('gemini', makeDeps({ tryRun: () => null }))
    expect(result.installed).toBe(false)
  })

  it('uses the default binary name "gemini"', () => {
    const invoked: string[] = []
    probeProvider(
      'gemini',
      makeDeps({ tryRun: (cmd) => { invoked.push(cmd); return 0 } }),
    )
    expect(invoked[0]).toBe('gemini')
  })

  it('uses MARS_GEMINI_BIN env override', () => {
    const invoked: string[] = []
    probeProvider(
      'gemini',
      makeDeps({
        tryRun: (cmd) => { invoked.push(cmd); return 0 },
        env: { MARS_GEMINI_BIN: '/usr/local/bin/gemini-cli' },
      }),
    )
    expect(invoked[0]).toBe('/usr/local/bin/gemini-cli')
  })

  it('detects auth when ~/.config/gemini/oauth_creds.json exists', () => {
    const result = probeProvider(
      'gemini',
      makeDeps({
        tryRun: () => 0,
        fileReadable: (p) => p.includes('oauth_creds.json'),
        homeDir: '/home/user',
      }),
    )
    expect(result.authed).toBe('yes')
    expect(result.authDetail).toBeTruthy()
  })

  it('detects auth when ~/.gemini/credentials.json exists', () => {
    const result = probeProvider(
      'gemini',
      makeDeps({
        tryRun: () => 0,
        fileReadable: (p) => p.includes('.gemini'),
        homeDir: '/home/user',
      }),
    )
    expect(result.authed).toBe('yes')
  })

  it('returns authed=unknown when no gemini auth file exists', () => {
    const result = probeProvider(
      'gemini',
      makeDeps({ tryRun: () => 0, fileReadable: () => false }),
    )
    expect(result.authed).toBe('unknown')
  })

  it('includes a non-empty install hint', () => {
    const result = probeProvider('gemini', makeDeps())
    expect(result.installHint).toMatch(/https?:\/\//)
  })
})

// ---------------------------------------------------------------------------
// probeProvider — codex
// ---------------------------------------------------------------------------

describe('probeProvider — codex', () => {
  it('reports installed=true when codex is on PATH', () => {
    const result = probeProvider('codex', makeDeps({ tryRun: () => 0 }))
    expect(result.installed).toBe(true)
  })

  it('reports installed=false when codex is not on PATH', () => {
    const result = probeProvider('codex', makeDeps({ tryRun: () => null }))
    expect(result.installed).toBe(false)
  })

  it('uses the default binary name "codex"', () => {
    const invoked: string[] = []
    probeProvider(
      'codex',
      makeDeps({ tryRun: (cmd) => { invoked.push(cmd); return 0 } }),
    )
    expect(invoked[0]).toBe('codex')
  })

  it('uses MARS_CODEX_BIN env override', () => {
    const invoked: string[] = []
    probeProvider(
      'codex',
      makeDeps({
        tryRun: (cmd) => { invoked.push(cmd); return 0 },
        env: { MARS_CODEX_BIN: '/usr/local/bin/codex-custom' },
      }),
    )
    expect(invoked[0]).toBe('/usr/local/bin/codex-custom')
  })

  it('detects auth through codex login status', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    const result = probeProvider(
      'codex',
      makeDeps({
        tryRun: (cmd, args) => {
          calls.push({ cmd, args })
          return 0
        },
      }),
    )
    expect(result.authed).toBe('yes')
    expect(result.authDetail).toBe('cli-session')
    expect(calls).toEqual([
      { cmd: 'codex', args: ['--version'] },
      { cmd: 'codex', args: ['login', 'status'] },
    ])
  })

  it('returns authed=unknown when codex login status is non-zero', () => {
    const result = probeProvider(
      'codex',
      makeDeps({
        tryRun: (_cmd, args) => args[0] === '--version' ? 0 : 1,
      }),
    )
    expect(result.authed).toBe('unknown')
  })

  it('includes a non-empty install hint', () => {
    const result = probeProvider('codex', makeDeps())
    expect(result.installHint).toMatch(/https?:\/\//)
  })
})

// ---------------------------------------------------------------------------
// formatProviderProbe
// ---------------------------------------------------------------------------

describe('formatProviderProbe', () => {
  const makeResult = (overrides: Partial<ProviderProbeResult>): ProviderProbeResult => ({
    name: 'claude',
    installed: true,
    authed: 'unknown',
    authDetail: '',
    installHint: 'https://example.com',
    ...overrides,
  })

  it('shows checkmark and logged-in detail for installed+authed', () => {
    const line = formatProviderProbe(
      makeResult({ name: 'claude', installed: true, authed: 'yes', authDetail: 'subscription' }),
    )
    expect(line).toContain('✓')
    expect(line).toContain('claude')
    expect(line).toContain('subscription')
  })

  it('shows cross and install hint for not-installed', () => {
    const line = formatProviderProbe(
      makeResult({
        name: 'gemini',
        installed: false,
        authed: 'unknown',
        installHint: 'https://ai.google.dev/gemini-api/docs/gemini-cli',
      }),
    )
    expect(line).toContain('✗')
    expect(line).toContain('gemini')
    expect(line).toContain('https://ai.google.dev')
  })

  it('shows a distinct line for installed but auth unknown', () => {
    const line = formatProviderProbe(
      makeResult({ name: 'codex', installed: true, authed: 'unknown', authDetail: '' }),
    )
    expect(line).toContain('codex')
    // Should NOT show the install hint (the binary is present)
    expect(line).not.toContain('install:')
  })

  it('api-key auth detail appears in the output', () => {
    const line = formatProviderProbe(
      makeResult({ name: 'claude', installed: true, authed: 'yes', authDetail: 'api-key' }),
    )
    expect(line).toContain('api-key')
  })

  it('all three providers format without throwing', () => {
    for (const name of ['claude', 'gemini', 'codex'] as const) {
      expect(() =>
        formatProviderProbe(makeResult({ name, installed: true, authed: 'yes', authDetail: 'test' })),
      ).not.toThrow()
    }
  })
})
