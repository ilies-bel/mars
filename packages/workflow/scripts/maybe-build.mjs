#!/usr/bin/env node
// Build dist/ via tsup when the toolchain is present.
//
// Background: this script is wired as the `prepare` lifecycle. `prepare`
// fires on every `npm install` / `npm ci` / `npm link` / git install. The
// raw command `tsup` crashes with exit 127 ("command not found") whenever
// the install ran without devDependencies — most notably when the
// orchestrator daemon (or any consumer) has `NODE_ENV=production` set, in
// which case `npm ci` silently skips devDeps. That left fresh worktrees
// failing setup with `sh: tsup: command not found` before any code step ran.
//
// This wrapper checks for the tsup bin in the local node_modules and
// skips with a clear log line when it is absent — the production install
// completes cleanly, and consumers that build (dev installs, publish) still
// get a real build because tsup IS present in those cases.
//
// `prepublishOnly` remains a hard `npm run build`, so a publish without
// devDeps still fails loudly the way it should.

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const tsupBin = resolve(packageRoot, 'node_modules', '.bin', 'tsup')

if (!existsSync(tsupBin)) {
  console.log(
    '[@mars/workflow prepare] tsup not installed (devDependencies skipped, ' +
      'likely NODE_ENV=production); skipping build. Run `npm run build` ' +
      'explicitly if you need dist/.',
  )
  process.exit(0)
}

const result = spawnSync(tsupBin, [], {
  cwd: packageRoot,
  stdio: 'inherit',
})

if (result.error) {
  console.error('[@mars/workflow prepare] failed to spawn tsup:', result.error)
  process.exit(1)
}

process.exit(result.status ?? 1)
