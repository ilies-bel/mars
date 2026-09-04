/**
 * Vitest global setup — runs before any test project starts.
 *
 * Generates ui/src/shared/action-queue-kinds.generated.ts from the
 * orchestrator source of truth so that drift-gate tests never fail
 * because of a stale or absent generated artifact — regardless of
 * whether vitest is invoked via `npm run test:src` or directly as
 * `npx vitest run`.
 */
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function setup() {
  const result = spawnSync('node', ['scripts/gen-action-queue-kinds.mjs'], {
    cwd: here,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(
      `gen-action-queue-kinds.mjs exited with status ${result.status ?? 'null'}`,
    )
  }
}
