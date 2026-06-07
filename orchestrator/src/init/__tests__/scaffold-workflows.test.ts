/**
 * Tests for the user-owned workflow scaffolder (ADR-0056) and the
 * diff-not-overwrite `mars update` reconciliation (ADR-0057).
 *
 * Covers:
 *   - planWorkflowCopies / planWorkflowConflicts / scaffoldWorkflows
 *   - the init-manifest extension (readOwnedWorkflowPaths, backward-compat)
 *   - unifiedDiff
 *   - updateWorkflows: created / unchanged / accepted / skipped / untouched,
 *     and the ADR-0057 guarantee that an owned file is never silently clobbered
 *     while an unowned (manifest-removed) file is left alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  planWorkflowCopies,
  planWorkflowConflicts,
  scaffoldWorkflows,
  WORKFLOWS_DEST_REL,
} from '../scaffold-workflows'
import {
  readInitManifest,
  readOwnedWorkflowPaths,
  writeInitManifest,
} from '../init-manifest'
import { unifiedDiff } from '../unified-diff'
import { updateWorkflows, type LineReader } from '../update'
import { runCommandInProcess, makeFakeDaemon } from '../../cli/test-adapter'
import type { OrchestratorContext } from '../../core/context'
import type { DomainTaskStore } from '../../core/store/task-store'

let repoRoot: string
let stateDir: string

beforeEach(() => {
  repoRoot = mkdtempSync(resolve(tmpdir(), 'mars-scaffold-wf-'))
  stateDir = resolve(repoRoot, '.mars')
  mkdirSync(stateDir, { recursive: true })
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

const destOf = (name: string): string =>
  resolve(repoRoot, WORKFLOWS_DEST_REL, name)

describe('planWorkflowCopies', () => {
  it('maps every bundled .js template into .mars/workflows/', () => {
    const copies = planWorkflowCopies(repoRoot)
    expect(copies.length).toBeGreaterThan(0)
    for (const c of copies) {
      expect(c.rel.startsWith(`${WORKFLOWS_DEST_REL}/`)).toBe(true)
      expect(c.rel.endsWith('.js')).toBe(true)
      expect(c.src.endsWith('.js')).toBe(true)
      expect(existsSync(c.src)).toBe(true)
    }
  })

  it('includes the documented core templates', () => {
    const rels = planWorkflowCopies(repoRoot).map((c) => c.rel)
    expect(rels).toContain(`${WORKFLOWS_DEST_REL}/task-workflow.js`)
    expect(rels).toContain(`${WORKFLOWS_DEST_REL}/fix-workflow.js`)
    expect(rels).toContain(`${WORKFLOWS_DEST_REL}/diagnose-workflow.js`)
    expect(rels).toContain(`${WORKFLOWS_DEST_REL}/write-workflow.js`)
  })

  it('does NOT include workflow-contract.md (only .js templates)', () => {
    const rels = planWorkflowCopies(repoRoot).map((c) => c.rel)
    expect(rels.some((r) => r.endsWith('.md'))).toBe(false)
  })
})

describe('planWorkflowConflicts', () => {
  it('returns empty on a fresh repo', () => {
    expect(planWorkflowConflicts(repoRoot)).toEqual([])
  })

  it('reports each existing destination file', () => {
    const first = planWorkflowCopies(repoRoot)[0]!
    mkdirSync(resolve(first.dest, '..'), { recursive: true })
    writeFileSync(first.dest, 'pre-existing', 'utf8')
    expect(planWorkflowConflicts(repoRoot)).toEqual([first.rel])
  })
})

describe('scaffoldWorkflows', () => {
  it('copies every template into a fresh repo and reports them in written', () => {
    const res = scaffoldWorkflows({ repoRoot, force: false })
    expect(res.status).toBe('ok')
    const expected = planWorkflowCopies(repoRoot).map((c) => c.rel)
    if (res.status === 'ok') expect(res.written.sort()).toEqual(expected.sort())
    for (const name of ['task-workflow.js', 'fix-workflow.js']) {
      expect(existsSync(destOf(name))).toBe(true)
    }
  })

  it('NEVER errors on a pre-existing dest and silently skips it (force:false)', () => {
    const userContent = '// my hand-edited task workflow\n'
    mkdirSync(resolve(repoRoot, WORKFLOWS_DEST_REL), { recursive: true })
    writeFileSync(destOf('task-workflow.js'), userContent, 'utf8')

    const res = scaffoldWorkflows({ repoRoot, force: false })
    expect(res.status).toBe('ok')
    // The pre-existing file is NOT in `written` (it was skipped, not copied).
    if (res.status === 'ok') {
      expect(res.written).not.toContain(`${WORKFLOWS_DEST_REL}/task-workflow.js`)
    }
    // And its content is untouched.
    expect(readFileSync(destOf('task-workflow.js'), 'utf8')).toBe(userContent)
  })

  it('force:true overwrites a pre-existing dest', () => {
    mkdirSync(resolve(repoRoot, WORKFLOWS_DEST_REL), { recursive: true })
    writeFileSync(destOf('task-workflow.js'), 'stale', 'utf8')

    const res = scaffoldWorkflows({ repoRoot, force: true })
    expect(res.status).toBe('ok')
    if (res.status === 'ok') {
      expect(res.written).toContain(`${WORKFLOWS_DEST_REL}/task-workflow.js`)
    }
    expect(readFileSync(destOf('task-workflow.js'), 'utf8')).not.toBe('stale')
  })

  it('dryRun reports the would-write set without touching disk', () => {
    const res = scaffoldWorkflows({ repoRoot, force: false, dryRun: true })
    expect(res.status).toBe('ok')
    if (res.status === 'ok') expect(res.written.length).toBeGreaterThan(0)
    expect(existsSync(destOf('task-workflow.js'))).toBe(false)
  })
})

describe('init-manifest extension — workflow paths', () => {
  it('readOwnedWorkflowPaths returns only paths under .mars/workflows/', () => {
    writeInitManifest(stateDir, [
      'CLAUDE.md',
      'frontend/CLAUDE.md',
      `${WORKFLOWS_DEST_REL}/task-workflow.js`,
      `${WORKFLOWS_DEST_REL}/fix-workflow.js`,
    ])
    expect(readOwnedWorkflowPaths(stateDir).sort()).toEqual(
      [
        `${WORKFLOWS_DEST_REL}/fix-workflow.js`,
        `${WORKFLOWS_DEST_REL}/task-workflow.js`,
      ].sort(),
    )
  })

  it('is backward-compatible: a manifest with no workflow entries yields []', () => {
    writeInitManifest(stateDir, ['CLAUDE.md', 'api/CLAUDE.md'])
    expect(readOwnedWorkflowPaths(stateDir)).toEqual([])
  })

  it('round-trips CLAUDE.md + workflow paths in one flat list (version 1)', () => {
    const paths = ['CLAUDE.md', `${WORKFLOWS_DEST_REL}/task-workflow.js`]
    writeInitManifest(stateDir, paths)
    expect(readInitManifest(stateDir)).toEqual(paths)
    const raw = JSON.parse(
      readFileSync(resolve(stateDir, 'init-manifest.json'), 'utf8'),
    ) as { version: number }
    expect(raw.version).toBe(1)
  })
})

describe('unifiedDiff', () => {
  it('returns empty string for identical content', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'f.js')).toBe('')
  })

  it('emits ---/+++ headers and -/+ lines for a change', () => {
    const out = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.js')
    expect(out).toContain('--- f.js')
    expect(out).toContain('+++ f.js')
    expect(out).toContain('-b')
    expect(out).toContain('+B')
    expect(out).toContain(' a')
    expect(out).toContain(' c')
  })

  it('handles pure additions', () => {
    const out = unifiedDiff('a\n', 'a\nb\n', 'f.js')
    expect(out).toContain('+b')
  })
})

const acceptReader: LineReader = async () => 'y'
const declineReader: LineReader = async () => 'n'
const throwReader: LineReader = async () => {
  throw new Error('prompt should not have been called')
}

describe('updateWorkflows — ADR-0057 ownership', () => {
  it('creates missing workflows fresh', async () => {
    const out: string[] = []
    const res = await updateWorkflows({
      repoRoot,
      stateDir,
      yes: false,
      readLine: throwReader,
      out: (s) => out.push(s),
    })
    expect(res.records.every((r) => r.outcome === 'created')).toBe(true)
    expect(existsSync(destOf('task-workflow.js'))).toBe(true)
    // Created files are recorded as owned in the manifest.
    expect(readOwnedWorkflowPaths(stateDir)).toContain(
      `${WORKFLOWS_DEST_REL}/task-workflow.js`,
    )
  })

  it('silently refreshes an identical file (unchanged, no prompt)', async () => {
    // Scaffold once so on-disk == template.
    scaffoldWorkflows({ repoRoot, force: false })
    writeInitManifest(
      stateDir,
      planWorkflowCopies(repoRoot).map((c) => c.rel),
    )
    const res = await updateWorkflows({
      repoRoot,
      stateDir,
      yes: false,
      readLine: throwReader, // must NOT be called for unchanged files
      out: () => {},
    })
    expect(res.records.every((r) => r.outcome === 'unchanged')).toBe(true)
  })

  it('shows a diff and APPLIES the template when the user accepts', async () => {
    const tmpl = readFileSync(planWorkflowCopies(repoRoot)[0]!.src, 'utf8')
    const rel = planWorkflowCopies(repoRoot)[0]!.rel
    const name = rel.split('/').pop()!
    mkdirSync(resolve(repoRoot, WORKFLOWS_DEST_REL), { recursive: true })
    writeFileSync(destOf(name), '// diverged\n' + tmpl, 'utf8')
    writeInitManifest(stateDir, [rel])

    const out: string[] = []
    const res = await updateWorkflows({
      repoRoot,
      stateDir,
      yes: false,
      readLine: acceptReader,
      out: (s) => out.push(s),
    })
    const record = res.records.find((r) => r.rel === rel)!
    expect(record.outcome).toBe('accepted')
    expect(readFileSync(destOf(name), 'utf8')).toBe(tmpl)
    expect(out.join('\n')).toContain('--- ' + rel)
  })

  it('shows a diff and KEEPS the user version when the user declines', async () => {
    const tmpl = readFileSync(planWorkflowCopies(repoRoot)[0]!.src, 'utf8')
    const rel = planWorkflowCopies(repoRoot)[0]!.rel
    const name = rel.split('/').pop()!
    const userContent = '// diverged-and-precious\n' + tmpl
    mkdirSync(resolve(repoRoot, WORKFLOWS_DEST_REL), { recursive: true })
    writeFileSync(destOf(name), userContent, 'utf8')
    writeInitManifest(stateDir, [rel])

    const res = await updateWorkflows({
      repoRoot,
      stateDir,
      yes: false,
      readLine: declineReader,
      out: () => {},
    })
    expect(res.records.find((r) => r.rel === rel)!.outcome).toBe('skipped')
    expect(readFileSync(destOf(name), 'utf8')).toBe(userContent)
  })

  it('--yes is non-interactive and defaults to skip-on-conflict', async () => {
    const tmpl = readFileSync(planWorkflowCopies(repoRoot)[0]!.src, 'utf8')
    const rel = planWorkflowCopies(repoRoot)[0]!.rel
    const name = rel.split('/').pop()!
    const userContent = '// ci-edited\n' + tmpl
    mkdirSync(resolve(repoRoot, WORKFLOWS_DEST_REL), { recursive: true })
    writeFileSync(destOf(name), userContent, 'utf8')
    writeInitManifest(stateDir, [rel])

    const res = await updateWorkflows({
      repoRoot,
      stateDir,
      yes: true,
      readLine: throwReader, // must NOT prompt under --yes
      out: () => {},
    })
    expect(res.records.find((r) => r.rel === rel)!.outcome).toBe('skipped')
    expect(readFileSync(destOf(name), 'utf8')).toBe(userContent)
  })

  it('leaves a diverged UNOWNED file (removed from the manifest) untouched', async () => {
    const tmpl = readFileSync(planWorkflowCopies(repoRoot)[0]!.src, 'utf8')
    const rel = planWorkflowCopies(repoRoot)[0]!.rel
    const name = rel.split('/').pop()!
    const handEdited = '// hand-edited, not in manifest\n' + tmpl
    mkdirSync(resolve(repoRoot, WORKFLOWS_DEST_REL), { recursive: true })
    writeFileSync(destOf(name), handEdited, 'utf8')
    // Manifest does NOT list this workflow → unowned.
    writeInitManifest(stateDir, ['CLAUDE.md'])

    const out: string[] = []
    const res = await updateWorkflows({
      repoRoot,
      stateDir,
      yes: false,
      readLine: throwReader, // must NOT prompt for an unowned file
      out: (s) => out.push(s),
    })
    expect(res.records.find((r) => r.rel === rel)!.outcome).toBe('untouched')
    expect(readFileSync(destOf(name), 'utf8')).toBe(handEdited)
    expect(out.join('\n')).toContain('left untouched')
  })

  it('manifest-owned files are NEVER silently overwritten (the core guarantee)', async () => {
    // Owned + diverged + decline → file content preserved byte-for-byte.
    const copies = planWorkflowCopies(repoRoot)
    mkdirSync(resolve(repoRoot, WORKFLOWS_DEST_REL), { recursive: true })
    const sentinels: Record<string, string> = {}
    for (const c of copies) {
      const name = c.rel.split('/').pop()!
      const content = `// PRECIOUS ${name}\n`
      sentinels[c.rel] = content
      writeFileSync(c.dest, content, 'utf8')
    }
    writeInitManifest(stateDir, copies.map((c) => c.rel))

    await updateWorkflows({
      repoRoot,
      stateDir,
      yes: true, // CI path: skip-on-conflict
      readLine: throwReader,
      out: () => {},
    })

    for (const c of copies) {
      const name = c.rel.split('/').pop()!
      expect(readFileSync(destOf(name), 'utf8')).toBe(sentinels[c.rel])
    }
  })
})

describe('mars update — command wiring (in-process)', () => {
  const fakeCtx = (): OrchestratorContext =>
    ({
      repoRoot,
      stateDir,
      queueDbPath: resolve(stateDir, 'mars.db'),
      observabilityDbPath: resolve(stateDir, 'observability.duckdb'),
      stateDbPath: resolve(stateDir, 'mars.db'),
      supervisorsDir: resolve(stateDir, 'supervisors'),
      supervisorsManifest: resolve(stateDir, 'supervisors', 'manifest.json'),
    }) as OrchestratorContext

  const stubStore = {} as unknown as DomainTaskStore

  it('routes `update` via dispatch and scaffolds missing workflows', async () => {
    // Daemon stands in for phase-1 init (force refresh of framework files).
    const fake = makeFakeDaemon((req) =>
      req.op === 'init' ? { status: 'ok', message: 'ok', written: ['CLAUDE.md'] } : {},
    )
    const r = await runCommandInProcess(['update', '--yes'], {
      store: stubStore,
      ctx: fakeCtx(),
      daemon: fake,
    })
    expect(r.unknown).toBeUndefined()
    expect(r.code).toBe(0)
    // Phase 1 hit the daemon init op with force.
    const initCall = fake.calls.find((c) => c.op === 'init') as
      | { op: 'init'; opts: { force: boolean } }
      | undefined
    expect(initCall?.opts.force).toBe(true)
    // Phase 2 scaffolded the workflows fresh.
    expect(existsSync(destOf('task-workflow.js'))).toBe(true)
    expect(r.out.join('\n')).toContain('workflows:')
  })

  it('under --yes never clobbers a diverged owned workflow', async () => {
    const tmpl = readFileSync(planWorkflowCopies(repoRoot)[0]!.src, 'utf8')
    const rel = planWorkflowCopies(repoRoot)[0]!.rel
    const name = rel.split('/').pop()!
    const userContent = '// cli-precious\n' + tmpl
    mkdirSync(resolve(repoRoot, WORKFLOWS_DEST_REL), { recursive: true })
    writeFileSync(destOf(name), userContent, 'utf8')
    writeInitManifest(stateDir, [rel])

    const fake = makeFakeDaemon((req) =>
      req.op === 'init' ? { status: 'ok', message: 'ok', written: [] } : {},
    )
    const r = await runCommandInProcess(['update', '--yes'], {
      store: stubStore,
      ctx: fakeCtx(),
      daemon: fake,
    })
    expect(r.code).toBe(0)
    expect(readFileSync(destOf(name), 'utf8')).toBe(userContent)
  })

  it('surfaces a daemon init abort as a non-zero exit', async () => {
    const fake = makeFakeDaemon((req) =>
      req.op === 'init'
        ? { status: 'aborted-conflict', message: 'refusing to overwrite' }
        : {},
    )
    const r = await runCommandInProcess(['update'], {
      store: stubStore,
      ctx: fakeCtx(),
      daemon: fake,
    })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('refusing to overwrite')
  })
})
