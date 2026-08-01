/**
 * Provider probe — pure, injectable utilities for detecting whether each
 * worker-provider CLI (claude, gemini, codex) is installed and authenticated.
 *
 * Used by two call sites:
 *   - `mars init`: shows paperclip-style worker CLI probe results during
 *     onboarding and lets the user pick a default worker provider.
 *   - `mars doctor`: reports per-provider auth status alongside the other
 *     preflight checks.
 *
 * All I/O is injectable via `ProviderProbeDeps` so tests never touch real
 * binaries, real files, or real environment variables.
 */

import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ProviderName } from '../../core/workers/provider-types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for provider probing. Production code passes
 * `realProviderProbeDeps`; tests inject a stub controlling every observable.
 */
export interface ProviderProbeDeps {
  /**
   * Attempt to run `cmd args`. Returns the exit code on success, or `null`
   * when the binary is not found (ENOENT). Non-zero exit codes still indicate
   * the binary exists (installed=true).
   */
  tryRun(cmd: string, args: readonly string[]): number | null
  /** Whether `path` exists and is readable. */
  fileReadable(path: string): boolean
  /** Environment variables (injectable for tests). */
  env: NodeJS.ProcessEnv
  /** Home directory (injectable for tests). */
  homeDir: string
}

/** Result of probing a single worker-provider CLI. */
export interface ProviderProbeResult {
  name: ProviderName
  /** Worker binary was found on PATH (or via MARS_<PROVIDER>_BIN override). */
  installed: boolean
  /**
   * Auth detection result:
   *   'yes'     — a credential file or API key was detected
   *   'unknown' — binary present but auth state can't be cheaply determined
   */
  authed: 'yes' | 'unknown'
  /**
   * Human-readable description of the auth signal found, e.g. 'api-key',
   * 'subscription', 'oauth', 'stored'. Empty string when authed='unknown'.
   */
  authDetail: string
  /** URL or command to install the provider CLI. */
  installHint: string
}

// ---------------------------------------------------------------------------
// Per-provider install hints
// ---------------------------------------------------------------------------

const INSTALL_HINTS: Record<ProviderName, string> = {
  claude: 'https://claude.ai/code',
  gemini: 'https://ai.google.dev/gemini-api/docs/gemini-cli',
  codex: 'https://github.com/openai/codex',
}

// ---------------------------------------------------------------------------
// Core probe logic
// ---------------------------------------------------------------------------

/**
 * Probe a single worker provider: check if its CLI binary is on PATH (or overridden
 * by MARS_<PROVIDER>_BIN) and cheaply detect auth state from known credential
 * files or environment variables.
 *
 * Auth detection is best-effort:
 *  - claude: ANTHROPIC_API_KEY env var OR ~/.claude/.credentials.json
 *  - gemini: ~/.config/gemini/oauth_creds.json OR ~/.gemini/credentials.json
 *  - codex: `codex login status` (supports file and OS-keyring sessions)
 *
 * Returns 'unknown' when the binary is present but no auth signal is found
 * — the user may still be authenticated via mechanisms we can't cheaply probe.
 */
export const probeProvider = (
  name: ProviderName,
  deps: ProviderProbeDeps,
): ProviderProbeResult => {
  const installHint = INSTALL_HINTS[name]

  // Per-worker-provider binary override: MARS_CLAUDE_BIN, MARS_GEMINI_BIN, MARS_CODEX_BIN
  const binEnvKey = `MARS_${name.toUpperCase()}_BIN`
  const binary = deps.env[binEnvKey] ?? name

  const exitCode = deps.tryRun(binary, ['--version'])
  const installed = exitCode !== null

  let authed: ProviderProbeResult['authed'] = 'unknown'
  let authDetail = ''

  if (name === 'claude') {
    if (deps.env['ANTHROPIC_API_KEY']) {
      authed = 'yes'
      authDetail = 'api-key'
    } else if (deps.fileReadable(join(deps.homeDir, '.claude', '.credentials.json'))) {
      authed = 'yes'
      authDetail = 'subscription'
    }
  } else if (name === 'gemini') {
    if (deps.fileReadable(join(deps.homeDir, '.config', 'gemini', 'oauth_creds.json'))) {
      authed = 'yes'
      authDetail = 'oauth'
    } else if (deps.fileReadable(join(deps.homeDir, '.gemini', 'credentials.json'))) {
      authed = 'yes'
      authDetail = 'oauth'
    }
  } else {
    // Codex worker authentication uses `codex login status`.
    if (installed && deps.tryRun(binary, ['login', 'status']) === 0) {
      authed = 'yes'
      authDetail = 'cli-session'
    }
  }

  return { name, installed, authed, authDetail, installHint }
}

/**
 * Format a ProviderProbeResult as a paperclip-style single line:
 *   ✓ claude worker CLI — logged in (subscription)
 *   ✗ gemini worker CLI — not installed (install: https://…)
 *   ? codex worker CLI  — installed (auth status unknown)
 */
export const formatProviderProbe = (result: ProviderProbeResult): string => {
  if (!result.installed) {
    return `✗ ${result.name} worker CLI — not installed (install: ${result.installHint})`
  }
  if (result.authed === 'yes') {
    return `✓ ${result.name} worker CLI — logged in (${result.authDetail})`
  }
  return `? ${result.name} worker CLI — installed (auth status unknown)`
}

// ---------------------------------------------------------------------------
// Real probe deps — wired at runtime
// ---------------------------------------------------------------------------

/** Production ProviderProbeDeps using real system calls. */
export const realProviderProbeDeps: ProviderProbeDeps = {
  tryRun(cmd, args) {
    const result = spawnSync(cmd, [...args], { stdio: 'ignore', timeout: 5_000 })
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
    }
    return result.status ?? null
  },
  fileReadable: existsSync,
  get env() {
    return process.env
  },
  get homeDir() {
    return homedir()
  },
}
