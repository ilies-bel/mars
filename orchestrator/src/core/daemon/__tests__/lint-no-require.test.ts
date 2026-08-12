/**
 * Lint gate: no bare `require(` in orchestrator/src production source files.
 *
 * The orchestrator runs as Node.js ESM ("type": "module" in package.json).
 * A bare `require(call)` in an ESM module is a ReferenceError at runtime;
 * it is not caught by the TypeScript compiler because @types/node declares
 * `require`, making tsc happy while the runtime crashes.
 *
 * This test was added after a total action-queue outage (mars-4e470f60) where
 * two `require()` calls in server.ts and derived-conditions.ts shipped past a
 * green typecheck and caused every /view/action-queue call to return HTTP 500.
 *
 * Rule: no production source file (*.ts that is NOT a *.test.ts and NOT under
 * __tests__/) may contain a bare `require(` call.
 *
 * Exceptions:
 *   - `createRequire(` — the ESM-sanctioned way to obtain a require function
 *     (used in node-sqlite.ts to work around a vitest/vite limitation).
 *   - Occurrences inside template literals or string literals that contain
 *     sub-scripts (script bodies spawned as child processes) — filtered by
 *     the regex below which only matches assignment-form requires.
 *
 * This test fails on the pre-fix codebase and passes after the fix.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Resolve the orchestrator/src/ directory relative to this test file.
// This file lives at orchestrator/src/core/daemon/__tests__/lint-no-require.test.ts
// so four levels up lands at orchestrator/src/.
const thisFile = fileURLToPath(import.meta.url)
const srcDir = resolve(thisFile, '..', '..', '..', '..', '..')

/**
 * Recursively collect all .ts files under dir that are NOT test files.
 * Test files: *.test.ts or any file under a __tests__/ directory.
 */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue
      results.push(...collectSourceFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      results.push(full)
    }
  }
  return results
}

/**
 * Returns true if the file-level content indicates it uses `createRequire` to
 * bind a local `require` variable — the one approved ESM workaround (node-sqlite.ts).
 * When true, `require(` calls in that file are legitimate calls to the local
 * binding and should not be flagged.
 */
function fileUsesCreateRequireBinding(content: string): boolean {
  return content.includes('const require = createRequire(')
}

/**
 * Returns true if the line contains a bare `require(` call that is not:
 * - A `createRequire(` call (legitimate ESM workaround)
 * - Part of a comment (// or *)
 * - Inside a string / template-literal value on the line
 *   (e.g. template strings embedding child-process script bodies)
 *
 * The heuristic: look for `require(` that is not immediately preceded by
 * "create" and not on a comment line, and not inside a quoted string value.
 */
function hasBareRequire(line: string): boolean {
  const trimmed = line.trimStart()
  // Skip pure comment lines.
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false

  // Strip inline comments to avoid false negatives.
  const codeOnly = line.replace(/\/\/.*$/, '')

  // Skip lines where require() appears inside a string/template-literal payload.
  // Heuristic: if the first non-whitespace token on the line is a quote or
  // backtick, the line is a string-value line (a multi-line template or array
  // element containing script text).
  const firstToken = trimmed[0]
  if (firstToken === '"' || firstToken === "'" || firstToken === '`') return false

  // Match `require(` where it is NOT preceded by `create` (i.e. not `createRequire(`).
  return /(?<!create)require\(/.test(codeOnly)
}

describe('lint: no bare require() in production source files', () => {
  it('finds no bare require( calls outside of createRequire', () => {
    const files = collectSourceFiles(srcDir)
    const violations: string[] = []

    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      // Skip files that declare a local require via createRequire — those are
      // the one approved ESM workaround (currently only node-sqlite.ts which works
      // around a vitest/vite limitation for node:sqlite).
      if (fileUsesCreateRequireBinding(content)) continue

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        if (hasBareRequire(line)) {
          violations.push(`${relative(srcDir, file)}:${i + 1}: ${line.trim()}`)
        }
      }
    }

    if (violations.length > 0) {
      // Print each violation for easy diagnosis.
      console.error(
        'Bare require() found in production source:\n' +
          violations.map((v) => `  ${v}`).join('\n') +
          '\n\nESM modules must use static import or await import() instead.',
      )
    }

    expect(violations).toEqual([])
  })
})
