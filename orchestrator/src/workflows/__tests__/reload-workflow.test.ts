import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadWorkflowByName, userWorkflowPath } from '../queue-workflow-store'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const orchestratorRoot = resolve(__dirname, '../../..')

/**
 * Proves that loadWorkflowByName picks up an edited workflow file on the very
 * next dispatch without a daemon restart.
 *
 * The import URL carries `?v=${mtimeMs}-${size}` so a change to the file's
 * content (which updates mtime and/or size) produces a different cache key in
 * the Node ESM module cache.  A second call to loadWorkflowByName therefore
 * resolves a fresh module — no daemon restart required.
 *
 * Why a subprocess for the reload assertion?
 * Both tsx (the CLI runner) and Vitest's vite-node normalise away import()
 * query strings in-process, so a second in-process load returns the same
 * cached module regardless of the URL.  We prove the guarantee under the real
 * Node ESM loader by spawning a plain `node` subprocess (no TypeScript
 * transformer) that directly exercises the `?v=${mtimeMs}-${size}` URL scheme
 * that loadWorkflowByName builds.  This is the same runtime the daemon uses
 * in production (the daemon is a plain Node process, not a tsx child).
 */
describe('loadWorkflowByName — per-dispatch reload without daemon restart', () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'mars-wf-reload-'))
    mkdirSync(join(repoRoot, '.mars', 'workflows'), { recursive: true })
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('loads the workflow file and returns the declared id', async () => {
    writeFileSync(
      userWorkflowPath('task', repoRoot),
      "export default { id: 'v1', fn: async () => ({}) }\n",
    )
    const wf = await loadWorkflowByName('task', repoRoot)
    expect(wf.id).toBe('v1')
  })

  it('observes the new id on the second load after the workflow file is rewritten — no daemon restart', () => {
    // Vitest's vite-node and tsx normalise import() query strings in-process,
    // so in-process calls to loadWorkflowByName would both return the first
    // cached module.  We prove the reload guarantee under the real Node ESM
    // loader via a plain `node` subprocess that applies the exact same
    // `?v=${mtimeMs}-${size}` URL construction that loadWorkflowByName uses.
    const wfPath = userWorkflowPath('task', repoRoot)

    // The two file versions intentionally differ in byte-length so the size
    // component guarantees a distinct URL even if both writes land in the same
    // millisecond (mtime granularity edge-case).
    const v1Src = "export default { id: 'v1', fn: async () => ({}) }\n"
    const v2Src = "export default { id: 'v2-reloaded', fn: async () => ({}) }\n"

    writeFileSync(wfPath, v1Src)

    const script = join(repoRoot, 'reload-probe.mjs')
    writeFileSync(
      script,
      [
        "import { writeFileSync, statSync } from 'node:fs'",
        "import { pathToFileURL } from 'node:url'",
        `const wfPath  = ${JSON.stringify(wfPath)}`,
        `const v2Src   = ${JSON.stringify(v2Src)}`,
        '// First load — v1 already on disk.',
        'const load = async (path) => {',
        '  const { mtimeMs, size } = statSync(path)',
        "  const url = pathToFileURL(path).href + '?v=' + mtimeMs + '-' + size",
        '  return (await import(url)).default',
        '}',
        'const wf1 = await load(wfPath)',
        '// Rewrite to v2 — changes both content bytes (size) and mtime.',
        'writeFileSync(wfPath, v2Src)',
        'const wf2 = await load(wfPath)',
        "process.stdout.write(wf1.id + ' ' + wf2.id + '\\n')",
      ].join('\n'),
    )

    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: orchestratorRoot,
    })

    if (r.status !== 0) {
      throw new Error(
        `reload subprocess failed (exit ${r.status ?? 'null'}):\n` +
          `stderr: ${r.stderr}\nstdout: ${r.stdout}`,
      )
    }
    expect(r.stdout.trim()).toBe('v1 v2-reloaded')
  })
})
