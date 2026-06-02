#!/usr/bin/env node
/**
 * Postinstall guard — runs AFTER pnpm installs packages.
 *
 * Problem: orchestrator/package.json lists @mars/workflow as a `file:` dep.
 * pnpm copies the package files into a content-addressable virtual store at
 * install time, respecting the `"files": ["dist"]` field in the package's
 * package.json.  Because dist/ is gitignored and produced only by `tsup`, a
 * fresh worktree or `rm -rf packages/workflow/dist` leaves nothing for pnpm
 * to copy — the virtual store entry has no dist, and every plain-node import
 * of `@mars/workflow` fails with "Cannot find module …/dist/index.js".
 *
 * Note: pnpm installs packages into the virtual store BEFORE lifecycle
 * scripts run, so `preinstall` is too early to help.  `postinstall` on the
 * root package runs after pnpm is done — we detect missing dist, build it,
 * then copy the result into node_modules/@mars/workflow (which writes into
 * the pnpm virtual-store entry via symlink) so plain-node imports work.
 *
 * The tsx / tsconfig-paths alias (@mars/workflow → packages/workflow/src) is
 * unaffected and keeps working regardless.  This guard is for pure-node
 * contexts (verify commands, daemon subprocesses that don't use tsx).
 *
 * Safe to run repeatedly: the check is a single `existsSync` call and returns
 * in under 1 ms when dist is already present.
 */

import { existsSync, cpSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
// orchestrator/scripts/ → orchestrator/
const orchestratorRoot = resolve(here, '..')
// orchestrator/ → repo-root/
const repoRoot = resolve(orchestratorRoot, '..')

/**
 * Local file: packages that produce a dist/ build and are direct dependencies
 * of the orchestrator.  Add entries here if new local packages with the same
 * pattern are introduced.
 *
 * name:       npm package name (used to locate node_modules entry)
 * srcDir:     path to the package source (absolute)
 * nmParts:    path segments under node_modules/ to reach the package dir
 */
const LOCAL_DEPS = [
  {
    name: '@mars/workflow',
    srcDir: resolve(repoRoot, 'packages', 'workflow'),
    nmParts: ['@mars', 'workflow'],
  },
]

for (const dep of LOCAL_DEPS) {
  const distCheckInSrc = resolve(dep.srcDir, 'dist', 'index.js')

  // Also check node_modules — if the virtual store already has dist there is
  // nothing to do regardless of the source state.
  const nmEntry = resolve(orchestratorRoot, 'node_modules', ...dep.nmParts)
  const distCheckInNm = resolve(nmEntry, 'dist', 'index.js')

  if (existsSync(distCheckInNm)) continue

  console.log(
    `[postinstall] ${dep.name}: dist/index.js absent from node_modules — ` +
    `building and injecting into virtual store`,
  )

  // Build from source if dist is also missing there.
  if (!existsSync(distCheckInSrc)) {
    // In a fresh worktree the package's own node_modules (and thus tsup) may
    // not exist yet.  Install dev deps first if tsup is not available.
    const tsupBin = resolve(dep.srcDir, 'node_modules', '.bin', 'tsup')
    if (!existsSync(tsupBin)) {
      console.log(
        `[postinstall] ${dep.name}: tsup not found, ` +
        `running npm install --ignore-scripts in ${dep.srcDir}`,
      )
      execSync('npm install --ignore-scripts', { cwd: dep.srcDir, stdio: 'inherit' })
    }

    execSync('npm run build', { cwd: dep.srcDir, stdio: 'inherit' })
    console.log(`[postinstall] ${dep.name}: build complete`)
  }

  // Inject dist into the node_modules entry.  `node_modules/@mars/workflow`
  // is a symlink to the pnpm virtual-store directory (a real directory), so
  // writing into it makes the files immediately importable via the symlink.
  const srcDist = resolve(dep.srcDir, 'dist')
  if (existsSync(srcDist) && existsSync(nmEntry)) {
    cpSync(srcDist, resolve(nmEntry, 'dist'), { recursive: true })
    console.log(`[postinstall] ${dep.name}: dist injected into node_modules`)
  }
}
