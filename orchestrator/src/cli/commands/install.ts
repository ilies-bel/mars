/**
 * Install-family leaves: `init`, `install`, `uninstall`, `plugin activate`,
 * `plugin deactivate`. These resolve the framework root from `import.meta.url`
 * and delegate to the already-DI-style modules under `src/commands/`.
 *
 * `init` is daemon-routed (the workflow runs inside the daemon); the rest are
 * local filesystem operations.
 */

import { join } from 'node:path'
import { MARS_VERSION } from '../../version'
import type { Command } from '../command'
import { errorMessage } from './shared'
import {
  probeProvider,
  formatProviderProbe,
  realProviderProbeDeps,
  type ProviderProbeDeps,
} from './provider-probe'
import type { ProviderName } from '../../core/workers/provider-types'

// Re-export so the provider probe types are accessible as part of install's
// public surface (two call sites: init command + doctor checks).
export type { ProviderProbeDeps, ProviderProbeResult } from './provider-probe'
export { probeProvider, formatProviderProbe, realProviderProbeDeps } from './provider-probe'

// ---------------------------------------------------------------------------
// Probe helpers — exported for unit testing (two call sites each: command +
// test). All are pure/injectable so tests never touch real filesystem or env.
// ---------------------------------------------------------------------------

/**
 * Known MARS_* env var overrides that affect day-to-day usage. Anything in
 * `process.env` with a `MARS_` prefix that is NOT in this map is an internal
 * timing/tuning var that has no effect on `mars init`.
 */
const KNOWN_MARS_OVERRIDE_NOTES: ReadonlyMap<string, string> = new Map([
  ['MARS_REPO', 'repo root override'],
  ['MARS_CLAUDE_BIN', 'claude worker binary path override'],
  ['MARS_GEMINI_BIN', 'gemini worker binary path override'],
  ['MARS_CODEX_BIN', 'codex worker binary path override'],
  ['MARS_WORKER_MODEL', 'worker model override (coder only)'],
  ['MARS_WORKER_PROVIDER', 'worker provider override (all workers)'],
  ['MARS_REFLECT_DISABLED', 'disables reflection tracking'],
  ['MARS_RECOVERY_DISABLED', 'disables failure recovery'],
  ['MARS_CODEX_BASE_URL', 'chat connector base URL override (default: https://chatgpt.com/backend-api/codex)'],
  ['MARS_CHAT_MODEL', 'chat model override (default: gpt-5.5)'],
  ['MARS_CHAT_EFFORT', 'chat reasoning effort override (default: high)'],
  ['MARS_CHAT_MAX_TOOL_TURNS', 'chat max tool turns per run override (default: 40)'],
  ['MARS_CHAT_REQUEST_TIMEOUT_MS', 'chat per-run wall-clock timeout override in ms (default: 600000)'],
])

/**
 * Scan an env object for `MARS_*` keys and split them into:
 *  - `active`: known user-facing overrides that are in effect
 *  - `ignored`: unknown/internal vars that do not affect `mars init`
 *
 * Empty-value vars are skipped in both lists.
 */
export const detectMarsEnvOverrides = (
  env: NodeJS.ProcessEnv,
): {
  active: Array<{ key: string; value: string; note: string }>
  ignored: Array<{ key: string; value: string; reason: string }>
} => {
  const active: Array<{ key: string; value: string; note: string }> = []
  const ignored: Array<{ key: string; value: string; reason: string }> = []
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('MARS_') || value === undefined || value === '') continue
    const note = KNOWN_MARS_OVERRIDE_NOTES.get(key)
    if (note !== undefined) {
      active.push({ key, value, note })
    } else {
      ignored.push({
        key,
        value,
        reason: 'internal tuning var — has no effect on init',
      })
    }
  }
  return { active, ignored }
}

/**
 * Produce a one-line auth-reuse note for the init output.
 *
 *  - `claudeAvailable = false` → empty string (doctor already reports the FAIL)
 *  - `apiKeySet = true`        → note that ANTHROPIC_API_KEY is in use
 *  - otherwise                 → Mars reuses the user's Claude Code login
 */
export const formatClaudeAuthNote = (
  claudeAvailable: boolean,
  apiKeySet: boolean,
): string => {
  if (!claudeAvailable) return ''
  if (apiKeySet) return '✓ Using ANTHROPIC_API_KEY for Claude authentication'
  return '✓ Using your existing Claude Code login — no API key needed'
}

/**
 * Return true when the target repo has already been initialised by `mars init`.
 * The marker is the init manifest `mars init` writes on every run (the old
 * `.mars/mars.db` sentinel died with the embedded-PostgreSQL migration — the
 * database is server-provisioned, not a file). The embedded-PG data dir is
 * accepted as a secondary signal so a repo whose daemon already provisioned a
 * database is never re-initialised destructively.
 * `fileExists` is injectable so tests never touch disk.
 */
export const checkAlreadyInitialized = (
  repoRoot: string,
  fileExists: (path: string) => boolean,
): boolean =>
  fileExists(join(repoRoot, '.mars', 'init-manifest.json')) ||
  fileExists(join(repoRoot, '.mars', 'pg', 'data'))

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const init: Command = {
  path: 'init',
  summary: 'scaffold CLAUDE.md, .claude/ config, workflow templates, and databases',
  usage:
    'usage: mars init [--force] [--dry-run] [--verbose] [--yes] [--start] [--wizard] [--wizard-off] [--skip-doctor] [--provider claude|gemini|codex]',
  run: async (args, deps) => {
    const { existsSync } = await import('node:fs')

    const boolFlags = new Set(args.positional.filter((a) => a.startsWith('--')))
    const force = boolFlags.has('--force')
    const dryRun = boolFlags.has('--dry-run')
    const verbose = boolFlags.has('--verbose')
    const yes = boolFlags.has('--yes') || boolFlags.has('-y')
    const start = boolFlags.has('--start')
    const wizardForced = boolFlags.has('--wizard')
    const wizardOff = boolFlags.has('--wizard-off')
    const skipDoctor = boolFlags.has('--skip-doctor')

    // ── Provider selection ────────────────────────────────────────────────
    // --provider <name> selects the default agent CLI for all Worker runs.
    // Defaults to 'codex'. Persisted to .mars/daemon.json after init.
    const VALID_PROVIDERS = new Set<string>(['claude', 'gemini', 'codex'])
    const providerRaw = args.flags['--provider']
    if (providerRaw !== undefined && !VALID_PROVIDERS.has(providerRaw)) {
      deps.err(
        `[mars init] --provider must be one of: claude, gemini, codex (got '${providerRaw}')`,
      )
      return { code: 1 }
    }
    const provider: ProviderName = (providerRaw as ProviderName | undefined) ?? 'codex'

    // ── Already-initialized idempotent check ─────────────────────────────
    // Preserve an existing .mars without re-running the wizard. --force bypasses
    // this so operators can re-initialize a repo explicitly.
    if (!force && checkAlreadyInitialized(deps.ctx.repoRoot, existsSync)) {
      deps.out('Mars is already initialized in this repository.')
      deps.out(`  ${join(deps.ctx.repoRoot, '.mars')} — found`)
      deps.out('')
      deps.out("Run 'mars update' to refresh workflow templates.")
      deps.out("Run 'mars doctor' to re-check prerequisites any time.")
      deps.out("Run 'mars init --force' to re-initialize (overwrites existing config).")
      return { code: 0 }
    }

    // ── Env-aware defaults ────────────────────────────────────────────────
    // Surface any MARS_* overrides the user has set so they know what's active.
    const { active: envActive, ignored: envIgnored } = detectMarsEnvOverrides(process.env)
    if (envActive.length > 0) {
      deps.out('[mars init] detected MARS_* overrides:')
      for (const e of envActive) deps.out(`  ${e.key}=${e.value}  (${e.note})`)
    }
    for (const e of envIgnored) {
      deps.out(
        `[mars init] note: ${e.key} is set but does not affect init (${e.reason})`,
      )
    }

    // ── Preflight doctor checks ───────────────────────────────────────────
    // Fail fast on hard failures (selected provider, git, Node version). WARN-only checks
    // (codegraph, daemon, DB) are printed but do not block. Pass --skip-doctor
    // to bypass entirely (e.g. in CI or when the environment is pre-validated).
    if (!skipDoctor) {
      const { runDoctorChecks, realProbes } = await import('./doctor')
      // Pass null for pgDsnPath — the daemon hasn't provisioned a DB yet
      // before init runs.
      const checks = await runDoctorChecks(
        realProbes,
        null,
        realProviderProbeDeps,
        provider,
      )
      const failures = checks.filter((c) => c.status === 'FAIL')
      const warns = checks.filter((c) => c.status === 'WARN')
      if (warns.length > 0) {
        for (const w of warns) deps.out(`[mars init] WARN ${w.label}: ${w.message}`)
      }
      if (failures.length > 0) {
        deps.err('[mars init] preflight failed — fix the following before running init:')
        for (const f of failures) deps.err(`  FAIL ${f.label}: ${f.message}`)
        deps.err('[mars init] pass --skip-doctor to bypass these checks')
        deps.err('[mars init] you can fix issues later with: mars doctor')
        return { code: 1 }
      }
    }

    // ── Auth reuse note ───────────────────────────────────────────────────
    // Print once so users know they do not need a separate API key.
    const authNote =
      provider === 'codex'
        ? '✓ Codex workers invoke the Codex CLI; chat reads CODEX_HOME/auth.json directly'
        : provider === 'claude'
          ? formatClaudeAuthNote(true, Boolean(process.env.ANTHROPIC_API_KEY))
          : '✓ Using your existing Gemini CLI login — Mars does not handle credentials'
    if (authNote) deps.out(`[mars init] ${authNote}`)

    // ── TTY routing (ADR-0058, updated) ───────────────────────────────────
    // Three paths:
    //   1. --wizard         → full interactive wizard (unchanged)
    //   2. TTY, no --yes    → quickstart: show defaults, one confirm prompt
    //   3. --yes / no TTY   → fully non-interactive, use defaults (no prompts)
    const isTTY = Boolean(process.stdin.isTTY)
    const runWizardPath = wizardForced
    const runQuickstartPath =
      isTTY && !yes && !wizardForced && !wizardOff

    if (runQuickstartPath) {
      deps.out('')
      deps.out('Mars quickstart — ready to initialize with sensible defaults:')
      deps.out('  Scaffold mode: full  (CLAUDE.md, .mcp.json, workflow templates)')
      deps.out('  Register:      yes')
      deps.out('')

      // Show per-provider probe results so users see what's available and
      // can decide whether to re-run with --provider <name>.
      deps.out('  Worker providers detected:')
      for (const name of ['claude', 'gemini', 'codex'] as const) {
        const probe = probeProvider(name, realProviderProbeDeps)
        deps.out(`    ${formatProviderProbe(probe)}`)
      }
      deps.out(`  Default worker provider: ${provider}`)
      if (provider === 'codex') {
        deps.out('  Auth: Codex workers invoke the Codex CLI; chat reads CODEX_HOME/auth.json directly.')
      }
      deps.out('')
      deps.out("  Tip: run 'mars init --wizard' for step-by-step configuration.")
      deps.out('')

      const { createInterface } = await import('node:readline')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const quickstartAnswer = await new Promise<string>((res) => {
        rl.question('Initialize now? [Y/n] ', (a) => {
          rl.close()
          res(a.trim().toLowerCase())
        })
      })
      if (quickstartAnswer === 'n' || quickstartAnswer === 'no') {
        deps.out("Initialization cancelled. Run 'mars init --wizard' to configure manually.")
        return { code: 0 }
      }
    }

    const { runInitWizard } = await import('../../init/wizard-controller')

    // Surface the value-bearing wizard flags to the controller. Boolean wizard
    // prompts read their flag from `args.positional` (the shared parser routes
    // bare `--flag` there); `--register-project` present = true.
    const wizardFlags: Record<string, string | boolean> = {}
    for (const [k, v] of Object.entries(args.flags)) wizardFlags[k] = v
    if (boolFlags.has('--register-project')) wizardFlags['--register-project'] = true

    // In quickstart mode the confirm was already done above, so wizard runs
    // non-interactively (flags/config/defaults only, no stdin hang).
    const wizardChoices = await runInitWizard({
      isTTY: runWizardPath && isTTY,
      flags: wizardFlags,
      force,
    })

    const result = (await deps.daemon.sendRequest(
      {
        op: 'init',
        opts: {
          force,
          dryRun,
          verbose,
          wizardChoices,
        },
      },
      { autoSpawn: true },
    )) as Awaited<ReturnType<typeof import('../../workflows/init-workflow').runInit>>

    if (result.status === 'dry-run') {
      deps.out('dry run: no files written')
      return { code: 0 }
    }
    if (
      result.status === 'aborted-existing' ||
      result.status === 'aborted-conflict'
    ) {
      deps.err(result.message)
      return { code: 1 }
    }

    deps.out('wrote:')
    for (const w of result.written ?? []) deps.out(`  ${w}`)

    // ── Persist provider choice ───────────────────────────────────────────
    // Write defaultProvider to .mars/daemon.json so every Worker dispatch path
    // picks it up on subsequent daemon runs. This is a best-effort
    // write — a failure is non-fatal (daemon.json is optional; missing = defaults).
    try {
      const { patchDaemonConfigFile } = await import('../../core/daemon/config')
      patchDaemonConfigFile({ defaultProvider: provider })
    } catch {
      // Non-fatal: daemon.json is optional config; init still succeeded.
    }

    // ── Summary card ──────────────────────────────────────────────────────
    const sep = '─'.repeat(40)
    deps.out('')
    deps.out(sep)
    deps.out(' Mars initialized successfully')
    deps.out(sep)
    deps.out(`  Repo:     ${deps.ctx.repoRoot}`)
    deps.out(`  Files:    ${(result.written ?? []).length} written`)
    deps.out(`  Provider: ${provider}`)
    deps.out('  Daemon:   will auto-start on first use')
    deps.out(sep)
    deps.out('')
    deps.out('Next commands:')
    deps.out(`  mars task add "describe the task"   # enqueue your first task`)
    deps.out(`  mars ui                              # read-only Kanban dashboard`)
    deps.out(`  mars doctor                          # re-check prerequisites any time`)

    // ── Start-now finale ──────────────────────────────────────────────────
    // With --yes --start: print non-interactively.
    // On a TTY without --yes: ask interactively.
    // With --yes alone: skip (quiet completion).
    if (start && yes) {
      deps.out('✓ Daemon running. Open the dashboard: mars ui')
    } else if (isTTY && !yes) {
      const { createInterface } = await import('node:readline')
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const startAnswer = await new Promise<string>((res) => {
        rl.question('\nStart Mars now? [y/N] ', (a) => {
          rl.close()
          res(a.trim().toLowerCase())
        })
      })
      if (startAnswer === 'y' || startAnswer === 'yes') {
        deps.out('✓ Daemon running. Open the dashboard: mars ui')
      }
    }

    return { code: 0 }
  },
}

const install: Command = {
  path: 'install',
  summary: 'install the framework templates into a consumer repo',
  usage: 'usage: mars install',
  run: async (_args, deps) => {
    const { fileURLToPath } = await import('node:url')
    const { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } =
      await import('node:fs')
    const { dirname: dirnameOf, resolve: pathResolve } = await import(
      'node:path'
    )
    const { runInstall } = await import('../../commands/install.js')
    type Manifest = import('../../commands/install.js').Manifest
    type InstallDeps = import('../../commands/install.js').InstallDeps

    const cliEntryPath = fileURLToPath(import.meta.url)
    // commands file lives at <root>/orchestrator/src/cli/commands/install.ts;
    // walk up four directories to the framework root.
    const frameworkRoot = dirnameOf(
      dirnameOf(dirnameOf(dirnameOf(dirnameOf(cliEntryPath)))),
    )
    const manifestPath = pathResolve(frameworkRoot, 'manifest.json')

    if (!existsSync(manifestPath)) {
      deps.err(`mars install: manifest not found at ${manifestPath}`)
      return { code: 1 }
    }

    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
    } catch (err: unknown) {
      deps.err(`mars install: failed to parse ${manifestPath}: ${errorMessage(err)}`)
      return { code: 1 }
    }

    const consumerRoot = deps.ctx.repoRoot
    const installDeps: InstallDeps = {
      readBytes: (srcPath: string): Buffer => readFileSync(srcPath),
      writeFile: (dstPath: string, content: Buffer, mode?: number): void => {
        mkdirSync(dirnameOf(dstPath), { recursive: true })
        writeFileSync(dstPath, content)
        if (mode !== undefined) chmodSync(dstPath, mode)
      },
      exists: (p: string): boolean => existsSync(p),
      log: (msg: string): void => deps.out(msg),
    }

    try {
      const result = await runInstall(
        manifest,
        frameworkRoot,
        consumerRoot,
        MARS_VERSION,
        installDeps,
      )
      deps.out(
        `mars install: ${result.outcome} (${result.lock.files.length} files)`,
      )
    } catch (err: unknown) {
      deps.err(`mars install: ${errorMessage(err)}`)
      return { code: 1 }
    }
    return { code: 0 }
  },
}

const uninstall: Command = {
  path: 'uninstall',
  summary: 'remove the dev wrapper and source clone',
  usage: 'usage: mars uninstall [--yes] [--wrapper <path>]',
  run: async (args, deps) => {
    const { fileURLToPath } = await import('node:url')
    const { existsSync } = await import('node:fs')
    const { rm } = await import('node:fs/promises')
    const { createInterface } = await import('node:readline')
    const { homedir } = await import('node:os')
    const { join: pathJoin } = await import('node:path')
    const { findWrapperFor, resolveUninstallPaths, runUninstall } =
      await import('../../commands/uninstall.js')
    const { deactivatePlugin, realDeps: pluginDeps } = await import(
      '../../commands/claude-plugin.js'
    )
    const userSettingsPath = pathJoin(homedir(), '.claude', 'settings.json')

    const yes = args.positional.includes('--yes') || args.positional.includes('-y')
    const isTty = Boolean(process.stdin.isTTY)

    const cliEntryPath = fileURLToPath(import.meta.url)
    const wrapperPath = args.flags['--wrapper'] ?? findWrapperFor(cliEntryPath)
    if (!wrapperPath) {
      deps.err(
        'mars uninstall: could not locate a wrapper binary on PATH that points at this installation.',
      )
      deps.err(
        'Run "which mars" to inspect your PATH, pass --wrapper <path>, or reinstall via install-dev.sh.',
      )
      return { code: 1 }
    }

    if (!yes && !isTty) {
      deps.err(
        'mars uninstall: stdin is not a terminal; pass --yes (or -y) to proceed non-interactively',
      )
      return { code: 1 }
    }

    const { binPath, srcDir } = resolveUninstallPaths(wrapperPath)
    deps.out(`wrapper: ${binPath}`)
    deps.out(`source:  ${srcDir}`)

    const rl =
      !yes && isTty
        ? createInterface({ input: process.stdin, output: process.stdout })
        : null

    const confirm = (): Promise<boolean> => {
      if (yes) return Promise.resolve(true)
      if (!rl) return Promise.resolve(false)
      return new Promise((resolveAnswer) => {
        rl.question(
          `Remove wrapper '${binPath}' and source clone '${srcDir}'? [y/N] `,
          (answer) => {
            resolveAnswer(answer.trim().toLowerCase() === 'y')
          },
        )
      })
    }

    try {
      const result = await runUninstall(binPath, srcDir, {
        exists: existsSync,
        removeFile: (p) => rm(p, { force: true }),
        removeDir: (p) => rm(p, { recursive: true, force: true }),
        confirm,
        log: (msg) => deps.out(msg),
        deactivateClaudePlugin: () =>
          deactivatePlugin(userSettingsPath, pluginDeps),
      })
      if (result.outcome === 'cancelled') {
        deps.out('uninstall cancelled')
      }
    } finally {
      rl?.close()
    }
    return { code: 0 }
  },
}

const pluginSettingsPath = async (): Promise<string> => {
  const { homedir } = await import('node:os')
  const { join: pathJoin } = await import('node:path')
  return pathJoin(homedir(), '.claude', 'settings.json')
}

const pluginActivate: Command = {
  path: 'plugin activate',
  summary: 'register the Mars Claude Code plugin',
  usage: 'usage: mars plugin activate <plugin-dir>',
  run: async (args, deps) => {
    const pluginDir = args.positional[0]
    if (!pluginDir) {
      deps.err('usage: mars plugin activate <plugin-dir>')
      return { code: 2 }
    }
    const { activatePlugin, realDeps } = await import(
      '../../commands/claude-plugin.js'
    )
    activatePlugin(pluginDir, await pluginSettingsPath(), realDeps)
    deps.out(`mars: Claude Code plugin activated at ${pluginDir}`)
    return { code: 0 }
  },
}

const pluginDeactivate: Command = {
  path: 'plugin deactivate',
  summary: 'deregister the Mars Claude Code plugin',
  usage: 'usage: mars plugin deactivate',
  run: async (_args, deps) => {
    const { deactivatePlugin, realDeps } = await import(
      '../../commands/claude-plugin.js'
    )
    deactivatePlugin(await pluginSettingsPath(), realDeps)
    deps.out('mars: Claude Code plugin deactivated')
    return { code: 0 }
  },
}

const pluginGroup: Command = {
  path: 'plugin',
  summary: 'plugin subcommands',
  usage: 'usage: mars plugin activate <path> | mars plugin deactivate',
  run: (args, deps) => {
    const subCmd = args.positional[0]
    deps.err(`mars plugin: unknown subcommand '${subCmd ?? ''}'`)
    deps.err('usage: mars plugin activate <path> | mars plugin deactivate')
    return { code: 2 }
  },
}

export const installCommands: readonly Command[] = [
  init,
  install,
  uninstall,
  pluginActivate,
  pluginDeactivate,
  pluginGroup,
]
