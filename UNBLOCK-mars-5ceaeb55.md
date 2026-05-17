# Unblock note for mars-5ceaeb55 — collapse to a single surgical write

mars-5ceaeb55 is itself an "unblock the parent" task. Its parent is
mars-7dbd72db (rework the read-span context-gathering child into a
GSD-style structured-diagnosis step with a branching outcome). The
implementor for mars-5ceaeb55 went into read-loop because the parent
prompt looks like an investigation to run rather than an action to take,
and was aborted by the read-span watcher after 5 reads.

## What mars-5ceaeb55's next dispatch must do (one Write, one commit)

Do NOT re-investigate. Do NOT attempt to implement the grandparent's
refactor yourself. The whole job is:

1. Create the file `UNBLOCK-mars-7dbd72db.md` in the worktree root with
   the EXACT content given in the fenced block below.
2. `git add UNBLOCK-mars-7dbd72db.md`
3. `git commit -m "docs: pin grandparent playbook for mars-7dbd72db read-span rework"`
4. Verify `git rev-list --count main..HEAD` prints `>= 1`. Exit.

That's it. No grep, no read of `implement-workflow.ts`, no test runs.
The whole purpose is to land a note in main so when mars-7dbd72db is
re-dispatched its worktree refreshes against main, the note is present,
and its implementor sees a precise playbook instead of a free-form brief.

## Exact content of `UNBLOCK-mars-7dbd72db.md`

Copy the block between the `<<<BEGIN>>>` and `<<<END>>>` markers verbatim.
Do not include the markers themselves.

```
<<<BEGIN>>>
# Unblock note for mars-7dbd72db — GSD-style diagnose-only child + verdict branch

The parent prompt asks for a single coherent refactor across two files
plus tests. The implementor previously stalled in read-loop because the
prompt reads like a design doc. Below is the precise action playbook —
follow it linearly; do not re-grep the call sites already named here.

## Files in scope (no others)

- `orchestrator/src/mastra/workflows/implement-workflow.ts`
  - `TOO_HARD_PREFIX` constant (~L262) — keep as-is.
  - `buildTooHardChildPrompt` (~L280-303) — REWRITE to diagnose-only.
  - Too-hard branch inside `codeStep` (~L730-773) — REWRITE to branch on
    the child's verdict. `enqueueTask` + `updateTask` + `addBlockers` are
    already imported at the top (L33-39); no new imports needed for the
    fix-worker path. For the inbox path, shell out to
    `mars inbox raise --from -` via `execFile` (already imported L2-6) —
    do NOT add a new lib dep.
- `orchestrator/src/mastra/daemon/server.ts`
  - `isTooHardAbortError` branch (~L345-348) — UPDATE the log line only.
    The branch already correctly returns without routing through generic
    failure handling; preserve that.

## Step 1 — Rewrite `buildTooHardChildPrompt` (diagnose-only contract)

Replace the body (keep the signature `(parentTaskId, parentPrompt, trace) => string`).
The new prompt MUST:

- Start with `# Diagnosis for ${parentTaskId}` (rename from
  "Context-gathering" so old grep patterns don't false-match).
- State explicitly: "You are a DIAGNOSE-ONLY worker. You MUST NOT make
  the fix yourself and MUST NOT attempt the parent task."
- Require the worker to end with EXACTLY one of two markdown blocks,
  written BOTH to a note file (`DIAGNOSIS-${parentTaskId}.md` in the
  worktree root) AND printed as its final message:

  ```
  ## ROOT CAUSE FOUND
  **Root Cause:** <specific cause with evidence>
  **Evidence Summary:**
  - <finding>
  **Files Involved:**
  - <path>: <what's wrong>
  **Suggested Fix Direction:** <hint, NOT an implementation>
  ```

  ```
  ## INVESTIGATION INCONCLUSIVE
  **What Was Checked:**
  - <area>: <finding>
  **Remaining Possibilities:**
  - <possibility>
  **Recommendation:** <next steps / why the parent prompt is too broad>
  ```

- Keep the existing `## Parent prompt` and `## Read trail before abort`
  sections; drop the old `(a)/(b)/mars idea add` wording entirely.
- State: "Pick exactly one verdict heading. Neither heading present →
  treated as INVESTIGATION INCONCLUSIVE."

EXPORT the function (currently const-only) so the new verdict-parser
helper and unit tests can call it: `export const buildTooHardChildPrompt = ...`.

## Step 2 — Add a verdict parser

Add (also exported) next to `buildTooHardChildPrompt`:

```ts
export type DiagnosisVerdict = 'root-cause' | 'inconclusive'

export const parseDiagnosisVerdict = (text: string): DiagnosisVerdict =>
  /^##\s+ROOT CAUSE FOUND\b/m.test(text) ? 'root-cause' : 'inconclusive'
```

Fail-safe: anything that isn't an unambiguous ROOT CAUSE FOUND heading
collapses to `'inconclusive'`. Do not throw.

## Step 3 — Rewrite the too-hard branch (~L730-773)

Pseudocode:

```
1. Build childPrompt = buildTooHardChildPrompt(parentTaskId, parentPrompt, trace)
2. const child = await enqueueTask(childPrompt, undefined, { skipTriage: true, originId })
3. await updateTask(parentTaskId, { status: 'blocked', error: <errorSummary>, failedPhase: 'code' })
4. await addBlockers(parentTaskId, [child.id])
5. Register a `task.completed` listener (or hook into the existing
   `onBlockerTaskCompleted` path — preferred; see daemon/server.ts) so
   that when child.id completes, the dispatcher reads the child's final
   message (or DIAGNOSIS-<parentTaskId>.md) and calls a new helper
   `handleDiagnosisVerdict(parentTaskId, parentPrompt, originId, child)`.
6. throw new Error(TOO_HARD_ABORT_MESSAGE(parentTaskId)) — unchanged.
```

`handleDiagnosisVerdict` (new helper in this same file or a sibling lib):
```
const verdict = parseDiagnosisVerdict(childFinalMessage)
if (verdict === 'root-cause') {
  const fixPrompt = `${parentPrompt.trim()}\n\n## Diagnosis from context-gathering\n\n${rootCauseBlock}\n\nApply the fix and Save your work.`
  const fix = await enqueueTask(fixPrompt, undefined, { skipTriage: true, originId })
  await addBlockers(parentTaskId, [fix.id])  // swap diagnose-child for fix-worker as the live blocker
  return
}
// inconclusive
await raiseInboxItem({ parentTaskId, childTaskId: child.id, readTrail: trace, summary: <inconclusive block> })
// leave parent parked in `blocked` (no live blocker) — matches existing exhausted-retry shape; see CLAUDE.md "Blockers" and the inbox-item handling near server.ts:318-345.
```

`raiseInboxItem` shells out:
```ts
const json = JSON.stringify({
  kind: 'diagnosis-inconclusive',
  priority: 'medium',
  parentTaskId,
  childTaskId: child.id,
  readTrail: trace,
  summary,
})
await execFileAsync('mars', ['inbox', 'raise', '--from', '-'], { input: json } as any)
```

(use `child_process.spawn` if `execFile`'s stdin contract is awkward; the
key is `mars inbox raise --from -` per AGENTS.md "File inbox items via
`mars inbox raise --from -`".)

WHERE to hook the verdict branch: the daemon already runs
`onBlockerTaskCompleted` (see CLAUDE.md "Blockers") on every completion.
The cleanest seam is to call `handleDiagnosisVerdict` from there when
the just-completed task is a diagnose-only child (mark it as such via
the child's `tag` or a row flag set at enqueue time — `tag: 'diagnose'`
is the cleanest; add it to `TASK_TAGS` if not already present).
Alternatively, inline the wait inside `codeStep` between steps 4 and 6
by awaiting the child's completion — but that holds an implement
semaphore slot and is NOT recommended. Use the bus seam.

## Step 4 — Update dispatcher log (server.ts ~L345-348)

Change:
```
log(`[implement] ${task.id} parked in blocked: read/grep span watcher tripped; spawned context-gathering child task`)
```
to:
```
log(`[implement] ${task.id} parked in blocked: read/grep span watcher tripped; spawned diagnose-only child (verdict branch will swap to a fix-worker or raise an inbox item)`)
```

No behavioural change to this branch — it already returns without
routing through the generic failure handler. Preserve that.

## Tests

Grep showed NO existing tests on `buildTooHardChildPrompt` or the
too-hard branch — only `lib/__tests__/read-span-watch.test.ts` (covers
the watcher itself) and `lib/__tests__/reflector.test.ts` (unrelated).
So no test rewrites are required; ADD a new test file
`src/mastra/workflows/__tests__/too-hard-verdict.test.ts` with three
cases:

1. `parseDiagnosisVerdict` returns `'root-cause'` for a string containing
   `## ROOT CAUSE FOUND`.
2. `parseDiagnosisVerdict` returns `'inconclusive'` for `## INVESTIGATION INCONCLUSIVE`
   AND for free-form text with neither heading (fail-safe).
3. `buildTooHardChildPrompt` output contains BOTH verdict heading
   templates, the "DIAGNOSE-ONLY" disclaimer, the parent prompt, and the
   formatted trace.

Integration test for the bus-seam verdict branch is OUT OF SCOPE for
this slice — file as `mars idea add` if you want it.

## Verify

```
cd orchestrator && npm run build
cd orchestrator && npx vitest run src/mastra/workflows/__tests__/too-hard-verdict.test.ts
```

Both must pass. If `npm run build` complains about an unused import
after the rewrite, delete the import — do not add `eslint-disable`.

## Save your work

```
git add -A
git commit -m "GSD-style diagnose-only too-hard child + verdict branch"
```

Then `git rev-list --count main..HEAD` MUST be `>= 1`.
<<<END>>>
```

## Why this unblocks mars-5ceaeb55 specifically

The mars-5ceaeb55 dispatch keeps reading because its prompt
("(a) write a note OR (b) make a surgical change") is itself a routing
decision the agent has to think through. Replacing that with a single
mechanical instruction ("create this file with this content") removes
all read budget pressure — there is nothing left to investigate.

## Save your work (for mars-5ceaeb55's next run)

```
git add UNBLOCK-mars-7dbd72db.md
git commit -m "docs: pin grandparent playbook for mars-7dbd72db read-span rework"
git rev-list --count main..HEAD  # must be >= 1
```
