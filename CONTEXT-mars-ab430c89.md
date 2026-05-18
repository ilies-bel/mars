# CONTEXT: mars-ab430c89 — originId span-stamping already on main

**Task**: Step 3 of 4 for idea 478c4083 (originId stamping) — stamp `originId`
on every Mastra span emitted by the workflows that touch a task or idea.

**Verdict**: No code change required. All acceptance criteria are already
satisfied on `main` by commit `73921cc feat(orchestrator): stamp every Mastra
span with originId for arc-level timelines`.

## Acceptance criteria mapping

### 1. `plan-workflow.ts` — `originId` in every `createStep` `execute()`

`generateStep.execute()` fetches the task via `getTask(inputData.taskId)` and
stamps the span immediately:

```ts
tracingContext?.currentSpan?.update({
  metadata: { originId: task.originId, taskId: task.id },
})
```

`task.originId` is the camelCase projection of `tasks.origin_id` returned by
`getTask()`. Per `resolveOriginIdForTask` (in `lib/origin.ts`) this falls back
to `task.id` when `origin_id` is NULL, ensuring a non-empty value even for
pre-migration rows.

### 2. `triage-workflow.ts` — same treatment

`generateStep.execute()` stamps the span via the same `task.originId` path:

```ts
tracingContext?.currentSpan?.update({
  metadata: { originId: task.originId, taskId: task.id },
})
```

### 3. `implement-workflow.ts` — all 4 steps independently stamped

Each step calls `resolveOriginIdForTask(inputData.taskId)` at entry and
stamps the span before any other work:

| Step | Line | Pattern |
|------|------|---------|
| `setup-worktree` | 567–570 | `resolveOriginIdForTask → update(metadata)` |
| `run-claude-code` | 808, 882–890 | `resolveOriginIdForTask → update(metadata)` |
| `verify` | 946–949 | `resolveOriginIdForTask → update(metadata)` |
| `merge` | 1113–1117, 1289–1297 | `resolveOriginIdForTask → update(metadata)` |

No parent-span inheritance relied upon — every step carries its own stamp.

### 4. `init-workflow.ts` — correctly skipped

`init-workflow.ts` accepts neither `taskId` nor `ideaId`; it has no
`tracingContext.currentSpan.update` calls. Requirement satisfied by absence.

### 5. `slice-workflow.ts` — `ideaId` as `originId` (bonus, consistent with spec)

The `generate-slices` step stamps `{ ideaId: idea.id, originId: idea.id }` so
spans for the slicer arc carry the same origin as the tasks it produces.

## Verification

`cd orchestrator && npx tsc --noEmit` — clean (0 errors, confirmed in this run).

The SQL query described in the task brief:

```sql
SELECT DISTINCT json_extract(metadata, '$.originId')
FROM span_events
WHERE json_extract(metadata, '$.originId') IS NOT NULL
```

will return the idea's id for every span in the arc once the daemon runs a
smoke cycle, because `tasks.origin_id` is set to the idea id at enqueue time
(via `mars-09a86529 + mars-bde88a87`, the merged prereqs).
