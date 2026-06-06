/**
 * Install-family leaves: `init`, `install`, `uninstall`, `plugin activate`,
 * `plugin deactivate`. These resolve the framework root from `import.meta.url`
 * and delegate to the already-DI-style modules under `src/commands/`.
 *
 * `init` is daemon-routed (the workflow runs inside the daemon); the rest are
 * local filesystem operations.
 */

import { MARS_VERSION } from '../../version'
import type { Command } from '../command'
import { errorMessage } from './shared'

const init: Command = {
  path: 'init',
  summary: 'detect tech stack and generate supervisors',
  usage:
    'usage: mars init [--force] [--dry-run] [--verbose] [--yes] [--wizard] [--wizard-off] [-f|--config <path>]',
  run: async (args, deps) => {
    const boolFlags = new Set(args.positional.filter((a) => a.startsWith('--')))
    const force = boolFlags.has('--force')
    const dryRun = boolFlags.has('--dry-run')
    const verbose = boolFlags.has('--verbose')
    const yes = boolFlags.has('--yes') || boolFlags.has('-y')
    const wizardForced = boolFlags.has('--wizard')
    const wizardOff = boolFlags.has('--wizard-off')
    const configPath = args.flags['--config']

    // Single-entry routing (ADR-0058). `mars init` is ONE command; whether it
    // runs the TTY wizard or a fully non-interactive path is decided here:
    //   - run the wizard when explicitly forced (`--wizard`), or on a TTY when
    //     neither `--yes` nor `--wizard-off` (nor an explicit config) opts out;
    //   - otherwise (no TTY, `--yes`, `--wizard-off`, or `-f <config>`) resolve
    //     choices non-interactively from flags + config + defaults — no prompt.
    const isTTY = Boolean(process.stdin.isTTY)
    const runWizardPath =
      wizardForced || (isTTY && !yes && !wizardOff && configPath === undefined)

    const { runInitWizard } = await import('../../init/wizard-controller')
    const { loadInitWizardConfig } = await import('../../init/init-config')

    // Surface the value-bearing wizard flags to the controller. Boolean wizard
    // prompts read their flag from `args.positional` (the shared parser routes
    // bare `--flag` there); `--register-project` present = true.
    const wizardFlags: Record<string, string | boolean> = {}
    for (const [k, v] of Object.entries(args.flags)) wizardFlags[k] = v
    if (boolFlags.has('--register-project')) wizardFlags['--register-project'] = true

    const wizardConfig = configPath
      ? loadInitWizardConfig(configPath, deps.ctx.repoRoot)
      : undefined

    // The controller only ever reads stdin when it is truly interactive: the
    // routing decision (`runWizardPath`) must AND with a real terminal so a
    // forced `--wizard` on a non-TTY cleanly falls back to flags/config/
    // defaults instead of blocking on stdin (no CI hang).
    const wizardChoices = await runInitWizard({
      isTTY: runWizardPath && isTTY,
      flags: wizardFlags,
      ...(wizardConfig ? { config: wizardConfig } : {}),
      force,
    })

    let result: Awaited<
      ReturnType<typeof import('../../workflows/init-workflow').runInit>
    >
    try {
      result = (await deps.daemon.sendRequest({
        op: 'init',
        opts: {
          force,
          dryRun,
          verbose,
          ...(configPath ? { configPath } : {}),
          wizardChoices,
        },
      })) as typeof result
    } catch (err: unknown) {
      const e = err as Error & { code?: string }
      if (e.code?.startsWith('init-config:')) {
        deps.err(`error: ${e.message}`)
        deps.err(`  config: ${e.code.slice('init-config:'.length)}`)
        return { code: 1 }
      }
      if (e.code?.startsWith('nested-tech:')) {
        const [outer, inner] = e.code.slice('nested-tech:'.length).split('::')
        deps.err(`error: ${e.message}`)
        deps.err(`  outer: ${outer}`)
        deps.err(`  inner: ${inner}`)
        return { code: 1 }
      }
      if (e.code?.startsWith('walk-access:')) {
        deps.err(`error: ${e.message}`)
        deps.err(`  path:  ${e.code.slice('walk-access:'.length)}`)
        return { code: 1 }
      }
      throw err
    }

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
    const { resolveLauncher, printUiDiscoveryHint } = await import('../ui')
    printUiDiscoveryHint(deps.ctx.repoRoot, resolveLauncher())
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
      return { code: 1 }
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
    return { code: 1 }
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
