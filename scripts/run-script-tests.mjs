#!/usr/bin/env node
/**
 * Runs every scripts/*.test.mjs — the release helpers' inline test suites.
 *
 * The set is DISCOVERED, not hand-listed. `test-scripts` used to chain four
 * filenames with `&&`; that shape is how ui/package.json's test:server silently
 * stopped running eight of its files. It also short-circuited, so a failure in
 * the first suite hid every later one.
 *
 * This runner executes all of them and reports a per-file pass/fail table, so
 * one broken helper does not mask the rest.
 */

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))

const files = readdirSync(scriptsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error(`run-script-tests: no *.test.mjs found in ${scriptsDir}`)
  process.exit(1)
}

console.log(`run-script-tests: ${files.length} suite(s)\n`)

const failed = []
for (const file of files) {
  const result = spawnSync(process.execPath, [join(scriptsDir, file)], { stdio: 'inherit' })
  const code = result.status ?? 1
  if (code !== 0) failed.push({ file, code })
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${file}${code === 0 ? '' : ` (exit ${code})`}\n`)
}

if (failed.length > 0) {
  console.error(
    `run-script-tests: ${failed.length}/${files.length} suite(s) failed — ` +
      failed.map((f) => f.file).join(', '),
  )
  process.exit(1)
}

console.log(`run-script-tests: ${files.length}/${files.length} suite(s) passed`)
