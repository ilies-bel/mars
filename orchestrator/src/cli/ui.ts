import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface LaunchOptions {
  repo?: string
  port?: string
  host?: string
}

const resolveLauncher = (): string | null => {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, '../../../ui/bin/mars-ui.mjs'),
    resolve(here, '../../ui/bin/mars-ui.mjs'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export const launchUi = (opts: LaunchOptions): void => {
  const launcher = resolveLauncher()
  if (!launcher) {
    console.error(
      'ui package not found; run `cd ui && npm install` or reinstall mars',
    )
    process.exit(1)
  }

  const args: string[] = []
  if (opts.repo) args.push('--repo', opts.repo)
  if (opts.port) args.push('--port', opts.port)
  if (opts.host) args.push('--host', opts.host)

  const child = spawn(process.execPath, [launcher, ...args], {
    stdio: 'inherit',
    env: process.env,
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  child.on('error', (err) => {
    console.error(`failed to launch mars ui: ${err.message}`)
    process.exit(1)
  })
}
