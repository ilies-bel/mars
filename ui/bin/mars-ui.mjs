#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const distDir = resolve(pkgRoot, 'dist')
const serverEntry = resolve(pkgRoot, 'server/index.ts')
const tsxBin = resolve(pkgRoot, 'node_modules/.bin/tsx')

const argv = [...process.argv.slice(2)]
if (!argv.includes('--dist') && existsSync(distDir)) {
  argv.push('--dist', distDir)
}

const child = spawn(tsxBin, [serverEntry, ...argv], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 0))
