#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const cli = resolve(here, '..', 'src', 'cli.ts')
const tsxBin = createRequire(import.meta.url).resolve('tsx/cli')

const child = spawn(process.execPath, [tsxBin, cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', (code) => process.exit(code ?? 1))
