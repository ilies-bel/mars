/**
 * Runtime loader for the `node:sqlite` builtin.
 *
 * vite 5 (bundled with vitest 2) does not recognize prefix-only builtins:
 * a static `import { DatabaseSync } from 'node:sqlite'` fails module
 * resolution under the test transform ("Failed to load url sqlite").
 * `createRequire` resolves at runtime and bypasses the transform entirely.
 * Delete this shim (and inline the static import) once vitest ships vite 6+.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
export type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite'
