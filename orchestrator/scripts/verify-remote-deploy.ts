#!/usr/bin/env tsx
/**
 * verify-remote-deploy.ts
 *
 * Operator smoke-test for the HITL remote-deploy preview flow.
 *
 * Flow:
 *   1. Enqueues a canned UI task with `mars task add --preview <cmd>`.
 *   2. Polls GET /view/tasks/<id> every 3 s until status=awaiting-validation
 *      and devServerUrl is non-null (or a 5-minute timeout fires).
 *   3. Prints the preview URL and waits for the operator to press ENTER.
 *   4. POSTs to /actions/validate/<id> — the daemon-level validate verb.
 *      There is no standalone `mars validate <id>` CLI subcommand; the HTTP
 *      API is the correct entry point (gap noted in commit message).
 *   5. Probes the devServerUrl with fetch every 2 s for up to 60 s, waiting
 *      for the server to stop accepting connections.
 *   6. Prints a one-line JSON summary to stdout and exits 0 (PASS) or
 *      non-zero (FAIL / TIMEOUT).
 *
 * SCHEMA GAPS (see commit message for details):
 *   - The brief references a `remoteUrl` field. The actual Task schema field
 *     is `devServerUrl`. This script uses the real field name.
 *   - The brief references `mars validate <id>`. No such CLI subcommand
 *     exists; validation is done through POST /actions/validate/<id>.
 *
 * Exit codes:
 *   0  PASS    — operator validated; preview server confirmed down within 60 s
 *   1  FAIL    — task failed before preview, preview boot failed, or server
 *                still live after the 60 s teardown window
 *   2  TIMEOUT — awaiting-validation not reached in 5 min, or server stayed
 *                up for the full 60 s teardown window
 *
 * Usage (from repo root or any subdirectory):
 *   tsx orchestrator/scripts/verify-remote-deploy.ts
 */

import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as readline from 'node:readline'

// ── Locate repo root ──────────────────────────────────────────────────────────

function findRepoRoot(startDir: string): string {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    cwd: startDir,
  })
  if (git.status === 0) {
    const root = git.stdout.trim()
    if (existsSync(resolve(root, '.mars', 'pg.dsn'))) return root
  }
  let dir = startDir
  while (true) {
    if (existsSync(resolve(dir, '.mars', 'pg.dsn'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir)
      throw new Error(
        'Could not find repo root — no .mars/pg.dsn found. Is the Mars daemon running?',
      )
    dir = parent
  }
}

const repoRoot = findRepoRoot(process.cwd())
const stateDir = resolve(repoRoot, '.mars')

// ── Read daemon state files ───────────────────────────────────────────────────

function readStateFile(name: string): string {
  const path = resolve(stateDir, name)
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path} — the Mars daemon is not running or was not started from this repo.`,
    )
  }
  return readFileSync(path, 'utf8').trim()
}

// Read http.port from .mars/http.port — never guess. Fail fast if absent.
const httpPort = readStateFile('http.port')

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise<void>((res) => setTimeout(res, ms))
}

type TaskRecord = {
  status: string
  devServerUrl: string | null
  [key: string]: unknown
}

async function fetchTask(id: string): Promise<TaskRecord | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${httpPort}/view/tasks/${id}`)
    if (!res.ok) return null
    const body = (await res.json()) as { task?: TaskRecord }
    return body.task ?? null
  } catch {
    return null
  }
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise<void>((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    rl.question(prompt, () => {
      rl.close()
      res()
    })
  })
}

// ── Enqueue canned preview task ───────────────────────────────────────────────

const uuid = randomUUID()
const markerFile = `scratch/remote-deploy-verify-${uuid}.html`
const marker = `REMOTE-DEPLOY-VERIFY-${uuid}`

// Ensure the scratch directory exists (mirrors verify-provider.ts pattern).
const scratchDir = resolve(repoRoot, 'scratch')
if (!existsSync(scratchDir)) {
  await mkdir(scratchDir, { recursive: true })
  await writeFile(resolve(scratchDir, '.gitkeep'), '')
}

const taskPrompt = `Create the file ${markerFile} containing exactly one line:
<h1>${marker}</h1>

Create parent directories if needed. Do not modify any other files.

Save your work:
  git add ${markerFile}
  git commit -m "verify-remote-deploy: ${marker}"`

// The preview command is run via sh -c in the task worktree. The daemon injects
// PORT as an env var; the server must listen on it. A self-contained Node.js
// one-liner avoids any extra runtime dependency.
const previewCmd =
  `node -e 'require("http").createServer((_,r)=>{r.writeHead(200);r.end("MARS verify-remote-deploy OK")}).listen(+process.env.PORT||0)'`

// The mars CLI rejects inline prompts containing newlines; write to a temp file
// and use --prompt-file so multi-line prompts are passed safely.
const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-verify-remote-deploy-'))
const promptFile = resolve(tmpDir, 'prompt.txt')
writeFileSync(promptFile, taskPrompt)

const addResult = spawnSync(
  'mars',
  [
    'task',
    'add',
    '--tag',
    'coder',
    '--verify',
    `test -f ${markerFile}`,
    '--done',
    `${markerFile} exists`,
    '--files',
    markerFile,
    '--preview',
    previewCmd,
    '--prompt-file',
    promptFile,
  ],
  { encoding: 'utf8', cwd: repoRoot },
)

// Clean up temp file regardless of outcome.
await rm(tmpDir, { recursive: true, force: true })

if (addResult.status !== 0) {
  console.error('[verify-remote-deploy] mars task add failed:')
  if (addResult.stderr) console.error(addResult.stderr)
  process.exit(1)
}

// Output format: "queued MARS-abc12345 (author: human:...)"
const addOutput = (addResult.stdout ?? '').trim()
const taskId = addOutput.split(/\s+/)[1]

if (!taskId) {
  console.error(`[verify-remote-deploy] Could not parse task ID from output:\n  ${addOutput}`)
  process.exit(1)
}

console.error(`[verify-remote-deploy] Enqueued ${taskId}`)
console.error('[verify-remote-deploy] Polling for awaiting-validation (timeout 5 min)…')

// ── Poll for awaiting-validation + devServerUrl ───────────────────────────────

const PREVIEW_POLL_MS = 3_000
const PREVIEW_TIMEOUT_MS = 5 * 60 * 1_000
const previewDeadline = Date.now() + PREVIEW_TIMEOUT_MS

let devServerUrl: string | null = null
let reachedValidation = false

while (Date.now() < previewDeadline) {
  const task = await fetchTask(taskId)
  if (task !== null) {
    const { status, devServerUrl: url } = task
    if (status === 'failed') {
      const summary = JSON.stringify({
        taskId,
        outcome: 'FAIL',
        reason: 'task-failed-before-preview',
        devServerUrl: null,
      })
      console.log(summary)
      process.exit(1)
    }
    if (status === 'awaiting-validation') {
      reachedValidation = true
      devServerUrl = url
      break
    }
    console.error(`[verify-remote-deploy] ${taskId} status=${status}`)
  }
  await sleep(PREVIEW_POLL_MS)
}

if (!reachedValidation) {
  const summary = JSON.stringify({
    taskId,
    outcome: 'TIMEOUT',
    reason: 'awaiting-validation-not-reached-in-5-min',
    devServerUrl: null,
  })
  console.log(summary)
  process.exit(2)
}

if (devServerUrl === null) {
  // Reached awaiting-validation but the preview server failed to boot.
  // The operator action-queue row will say "preview failed to boot".
  const summary = JSON.stringify({
    taskId,
    outcome: 'FAIL',
    reason: 'preview-server-boot-failed',
    devServerUrl: null,
  })
  console.log(summary)
  process.exit(1)
}

// devServerUrl is non-null past this point; capture in a const so TypeScript
// tracks the narrowed type correctly across the remaining await boundaries.
const confirmedUrl: string = devServerUrl

// ── Present URL to operator ───────────────────────────────────────────────────

console.error(`\n[verify-remote-deploy] Task ${taskId} is awaiting validation.`)
console.error(`[verify-remote-deploy] Preview URL: ${confirmedUrl}`)
console.error('[verify-remote-deploy] Open the URL, review, then press ENTER to validate…\n')

await waitForEnter('Press ENTER to validate > ')

// ── Validate via daemon HTTP API ──────────────────────────────────────────────
// NOTE: `mars validate <id>` does not exist as a CLI subcommand.
// The supported entry point is POST /actions/validate/:id on the daemon HTTP API.

console.error(`[verify-remote-deploy] Sending validate for ${taskId}…`)

const validateRes = await fetch(`http://127.0.0.1:${httpPort}/actions/validate/${taskId}`, {
  method: 'POST',
})

if (!validateRes.ok) {
  const body = await validateRes.text().catch(() => '')
  console.error(
    `[verify-remote-deploy] POST /actions/validate/${taskId} failed: ${validateRes.status} ${body}`,
  )
  const summary = JSON.stringify({
    taskId,
    outcome: 'FAIL',
    reason: 'validate-post-failed',
    devServerUrl: confirmedUrl,
  })
  console.log(summary)
  process.exit(1)
}

console.error(
  `[verify-remote-deploy] Validated. Probing ${confirmedUrl} for teardown (timeout 60 s)…`,
)

// ── Probe URL until server goes down ──────────────────────────────────────────

const TEARDOWN_POLL_MS = 2_000
const TEARDOWN_TIMEOUT_MS = 60_000
const teardownDeadline = Date.now() + TEARDOWN_TIMEOUT_MS

let serverDown = false

while (Date.now() < teardownDeadline) {
  try {
    const probeRes = await fetch(confirmedUrl, { signal: AbortSignal.timeout(3_000) })
    if (!probeRes.ok) {
      // Any non-2xx (including 404) means the server is not serving normally.
      serverDown = true
      break
    }
    console.error(`[verify-remote-deploy] Server still up (${probeRes.status}), waiting…`)
  } catch {
    // Connection refused, timeout, or network error — server is down.
    serverDown = true
    break
  }
  await sleep(TEARDOWN_POLL_MS)
}

// ── Print one-line JSON summary and exit ──────────────────────────────────────

if (serverDown) {
  const summary = JSON.stringify({
    taskId,
    outcome: 'PASS',
    reason: 'preview-server-confirmed-down',
    devServerUrl: confirmedUrl,
  })
  console.log(summary)
  process.exit(0)
} else {
  const summary = JSON.stringify({
    taskId,
    outcome: 'TIMEOUT',
    reason: 'server-still-live-after-60s-teardown-window',
    devServerUrl: confirmedUrl,
  })
  console.log(summary)
  process.exit(2)
}
