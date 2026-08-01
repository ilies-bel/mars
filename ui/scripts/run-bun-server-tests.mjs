#!/usr/bin/env node
/**
 * Runs the Bun-native half of ui/server/ under the real Bun runtime.
 *
 * Why this exists rather than a literal `bun test server/`:
 *
 * ui/server/ holds two kinds of test file, distinguished by what they import
 * their primitives from:
 *
 *   - `bun:test`  — executable by both Bun and vitest (vitest.config.ts aliases
 *                   `bun:test` to src/bun-test-compat.ts).
 *   - `vitest`    — executable by vitest ONLY. They rely on vitest's ESM
 *                   namespace patching (`vi.spyOn(namespaceImport, 'fn')`),
 *                   which Bun cannot do. `bun test server/` fails all of them.
 *
 * The server itself runs on Bun (`npm run dev:server` → `bun run server/index.ts`),
 * so the `bun:test` files are worth exercising under the real runtime and not
 * only through vitest's compatibility shim.
 *
 * The set is DERIVED from the import statement, never hand-listed. package.json
 * previously hardcoded 13 filenames while the directory held 21; the list went
 * stale and ui/server/chatRoutes.test.ts never executed under any runner. A
 * derived set cannot drift: drop in a new `bun:test` file and it is picked up.
 *
 * vitest independently runs ALL of ui/server/**\/*.test.ts via a glob, so every
 * file has a home regardless of which primitives it imports.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'server')

const files = readdirSync(serverDir)
  .filter((name) => name.endsWith('.test.ts'))
  .filter((name) => /from ['"]bun:test['"]/.test(readFileSync(join(serverDir, name), 'utf8')))
  .map((name) => `server/${name}`)
  .sort()

if (files.length === 0) {
  // Never fall through to a bare `bun test`: with no positional filters Bun
  // would run the whole tree, including the vitest-only files that cannot pass.
  console.error(
    'run-bun-server-tests: found no ui/server/*.test.ts importing from "bun:test".\n' +
      'That is almost certainly a bug in this script, not an empty test suite.',
  )
  process.exit(1)
}

console.log(`run-bun-server-tests: ${files.length} Bun-native file(s) in ui/server/`)

const result = spawnSync('bun', ['test', ...files], {
  cwd: dirname(serverDir),
  stdio: 'inherit',
})

if (result.error) {
  console.error(`run-bun-server-tests: failed to spawn bun — ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
