/**
 * Bundled workflow template loader acceptance test.
 *
 * Iterates over every `.js` template in `templates/workflows/` and verifies
 * that each one would be accepted by the workflow loader without a
 * WorkflowLoadError. The loader checks two things:
 *
 *   1. The file is importable (no syntax errors, import resolution).
 *   2. The default export has `{ id: string, fn: function }`.
 *
 * Because the template files import from `'mars/workflow'` (the orchestrator's
 * own export surface — authoring.ts, a TypeScript file) and the test runner
 * uses a dynamic `import(fileURL)` path, we mock `'mars/workflow'` with inert
 * stubs so module loading succeeds without executing real primitives. The mock
 * `defineWorkflow` is an identity function so the default export is the raw
 * workflow spec — exactly what the loader's `isWorkflowShape` guard checks.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

// Mock mars/workflow BEFORE any template imports so the stubs are in place
// when vite-node processes each template file's import statement.
// defineWorkflow is an identity function: `export default defineWorkflow({...})`
// becomes `export default { id, fn }` — exactly the shape the loader checks.
vi.mock('mars/workflow', () => ({
  defineWorkflow: (spec: unknown) => spec,
  setupWorktree: () => Promise.resolve({ path: '(mock)', branch: 'mock' }),
  runAgent: () => Promise.resolve({}),
  verify: () => Promise.resolve({}),
  merge: () => Promise.resolve({ taskId: 'mock', success: true, message: 'ok' }),
  awaitHuman: () => Promise.resolve({}),
}))

const TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
  'workflows',
)

/** All bundled .js workflow templates, in sorted order. */
const templateFiles = readdirSync(TEMPLATES_DIR)
  .filter((name) => name.endsWith('.js'))
  .sort()

/** Derive the workflow kind from a filename like `task-workflow.js` → `task`. */
const kindFromFilename = (filename: string): string =>
  filename.replace(/-workflow\.js$/, '')

describe('bundled workflow templates — loader acceptance', () => {
  it('finds at least the core bundled templates', () => {
    const files = templateFiles
    expect(files).toContain('task-workflow.js')
    expect(files).toContain('fix-workflow.js')
    expect(files).toContain('diagnose-workflow.js')
    expect(files).toContain('write-workflow.js')
    expect(files).toContain('runbook-workflow.js')
  })

  for (const filename of templateFiles) {
    const kind = kindFromFilename(filename)
    const src = resolve(TEMPLATES_DIR, filename)

    describe(`${filename}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mod: any

      beforeAll(async () => {
        // Dynamic import via file URL — vite-node intercepts this and applies
        // the vi.mock('mars/workflow') stub, so the template's import of
        // mars/workflow primitives resolves without executing real side effects.
        mod = await import(pathToFileURL(src).href)
      })

      it('has a non-empty source file', () => {
        const content = readFileSync(src, 'utf8')
        expect(content.length).toBeGreaterThan(0)
      })

      it(`default-exports a workflow object with id '${kind}' and fn`, () => {
        // This is exactly the check performed by isWorkflowShape() in
        // queue-workflow-store.ts — what the loader validates before accepting
        // a file. If either check fails, the loader would throw WorkflowLoadError.
        expect(typeof mod.default?.id).toBe('string')
        expect(mod.default.id).toBe(kind)
        expect(typeof mod.default?.fn).toBe('function')
      })

      it('carries the @mars-workflow-template marker', () => {
        const firstLine = readFileSync(src, 'utf8').split('\n')[0] ?? ''
        expect(firstLine).toMatch(/^\/\/ @mars-workflow-template:v\d+$/)
      })
    })
  }
})
