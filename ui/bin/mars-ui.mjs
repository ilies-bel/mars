#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const distDir = resolve(pkgRoot, 'dist')
const serverEntry = resolve(pkgRoot, 'server/index.ts')

const argv = [...process.argv.slice(2)]
if (!argv.includes('--dist') && existsSync(distDir)) {
  argv.push('--dist', distDir)
}

const child = spawn('bun', ['run', serverEntry, ...argv], {
  stdio: 'inherit',
  env: process.env,
})
child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(
      'mars-ui: bun not found on PATH. Install Bun (https://bun.sh) and re-run.',
    )
    process.exit(127)
  }
  console.error(`mars-ui: failed to spawn bun: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 0))
