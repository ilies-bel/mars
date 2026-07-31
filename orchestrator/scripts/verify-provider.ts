#!/usr/bin/env tsx
/**
 * verify-provider.ts
 *
 * Operator script: enqueues a trivial Coder task, polls until it reaches
 * `done` or `failed`, then prints a one-line summary and exits.
 *
 * Output format (stdout):
 *   provider=<name> commit=<sha|none> status=<done|failed> outcome=<PASS|FAIL>
 *
 * Exit codes:
 *   0  PASS  — task reached `done`
 *   1  FAIL  — task reached `failed`
 *   2  timeout — task did not finish within 10 min
 *
 * Prerequisites: `mars` daemon must be running and MARS_WORKER_PROVIDER must
 * be set (or the daemon restarted with the desired provider) before running
 * this script. See verify-provider.README.md for details.
 *
 * Usage (from repo root or any subdirectory):
 *   tsx orchestrator/scripts/verify-provider.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { verificationOutcome } from './verify-provider-output'

// ── Locate repo root ────────────────────────────────────────────────────────

function findRepoRoot(startDir: string): string {
  // Prefer git to determine the root (works from any subdirectory)
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    cwd: startDir,
  })
  if (git.status === 0) {
    const root = git.stdout.trim()
    if (existsSync(resolve(root, '.mars', 'pg.dsn'))) return root
  }
  // Fallback: walk up until we find .mars/pg.dsn
  let dir = startDir
  while (true) {
    if (existsSync(resolve(dir, '.mars', 'pg.dsn'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir)
      throw new Error(
        'Could not find repo root — no .mars/pg.dsn found. ' +
          'Is the Mars daemon running?',
      )
    dir = parent
  }
}

const repoRoot = findRepoRoot(process.cwd())
const stateDir = resolve(repoRoot, '.mars')

// ── Read daemon connection files ─────────────────────────────────────────────

function readStateFile(name: string): string {
  const path = resolve(stateDir, name)
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path} — the Mars daemon is not running or was not started from this repo.`,
    )
  }
  return readFileSync(path, 'utf8').trim()
}

// Read both files now so we fail fast if the daemon isn't up.
// pgDsn is validated but not used directly in this script — the heavy lifting
// goes through the `mars` CLI which finds its own DSN.
const _pgDsn = readStateFile('pg.dsn') // presence check only
const httpPort = readStateFile('http.port')

void _pgDsn // suppress "unused variable" lint; the read above is the intent

// ── Resolve provider ─────────────────────────────────────────────────────────

function resolveProvider(): string {
  if (process.env.MARS_WORKER_PROVIDER) return process.env.MARS_WORKER_PROVIDER
  const daemonJsonPath = resolve(stateDir, 'daemon.json')
  if (existsSync(daemonJsonPath)) {
    try {
      const cfg = JSON.parse(readFileSync(daemonJsonPath, 'utf8')) as Record<string, unknown>
      if (typeof cfg.defaultProvider === 'string' && cfg.defaultProvider)
        return cfg.defaultProvider
    } catch {
      // ignore parse errors
    }
  }
  return 'claude'
}

const provider = resolveProvider()

// ── Enqueue task ─────────────────────────────────────────────────────────────

const uuid = randomUUID()
const marker = `PROVIDER-VERIFY-${uuid}`

// Ensure the scratch directory exists so the prompt is valid
const scratchDir = resolve(repoRoot, 'scratch')
if (!existsSync(scratchDir)) {
  await mkdir(scratchDir, { recursive: true })
  // Create a .gitkeep so the directory can be committed if needed
  await writeFile(resolve(scratchDir, '.gitkeep'), '')
}

const prompt = `Append the string ${marker} to scratch/verify-provider.txt.
Create the file if it does not exist. Do not modify any other files.

Save your work:
  git add scratch/verify-provider.txt
  git commit -m "verify-provider: append ${marker}"`

const addResult = spawnSync(
  'mars',
  [
    'task',
    'add',
    '--tag',
    'coder',
    '--verify',
    'true',
    '--done',
    'true',
    '--files',
    'scratch/verify-provider.txt',
    prompt,
  ],
  { encoding: 'utf8', cwd: repoRoot },
)

if (addResult.status !== 0) {
  console.error('mars task add failed:')
  if (addResult.stderr) console.error(addResult.stderr)
  process.exit(1)
}

// Output: "queued MARS-abc12345 (author: human:...)"
const addOutput = (addResult.stdout ?? '').trim()
const taskId = addOutput.split(/\s+/)[1]

if (!taskId) {
  console.error(`Could not parse task ID from mars task add output:\n  ${addOutput}`)
  process.exit(1)
}

console.error(`[verify-provider] Enqueued ${taskId}  (provider=${provider})`)
console.error(`[verify-provider] Polling every 2 s, timeout 10 min…`)

// ── Poll task status via HTTP API ────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000
const TIMEOUT_MS = 10 * 60 * 1_000

type TaskRecord = {
  status: string
  [key: string]: unknown
}

async function fetchTask(id: string): Promise<TaskRecord | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/tasks/${id}`)
    if (!res.ok) return null
    const body = (await res.json()) as { task?: TaskRecord }
    return body.task ?? null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

const deadline = Date.now() + TIMEOUT_MS
let finalStatus = ''

while (Date.now() < deadline) {
  const task = await fetchTask(taskId)
  if (task != null) {
    const { status } = task
    if (status === 'done' || status === 'failed') {
      finalStatus = status
      break
    }
    console.error(`[verify-provider] ${taskId} status=${status}`)
  }
  await sleep(POLL_INTERVAL_MS)
}

// ── Timeout ───────────────────────────────────────────────────────────────────

if (!finalStatus) {
  console.log(`provider=${provider} commit=none status=timeout outcome=FAIL`)
  process.exit(2)
}

// ── Find commit SHA ───────────────────────────────────────────────────────────

let commitSha = 'none'

if (finalStatus === 'done') {
  // Search main for the unique marker rather than the task id: successful
  // fast-forward merges preserve the Coder's commit message, which need not
  // contain the task id.
  const gitLog = spawnSync(
    'git',
    [
      'log',
      'main',
      `-S${marker}`,
      '--format=%H',
      '-1',
      '--',
      'scratch/verify-provider.txt',
    ],
    { encoding: 'utf8', cwd: repoRoot },
  )
  const sha = (gitLog.stdout ?? '').trim()
  if (sha) commitSha = sha
}

// ── Print summary and exit ────────────────────────────────────────────────────

const outcome = verificationOutcome(finalStatus as 'done' | 'failed', commitSha)
console.log(`provider=${provider} commit=${commitSha} status=${finalStatus} outcome=${outcome}`)
process.exit(outcome === 'PASS' ? 0 : 1)
