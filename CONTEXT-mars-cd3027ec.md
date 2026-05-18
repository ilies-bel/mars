# CONTEXT: mars-cd3027ec — auto-supersede inbox item on origin done/dropped/purged already on main

**Task**: Slice 4 of 10 for PRD 068e7ae3 (unify the inbox) — the daemon's
invalidator engine closes (supersedes) an inbox item the moment its origin
task reaches done, dropped, or is purged. No operator ack/dismiss required.

**Verdict**: No code change required. All acceptance criteria are already
satisfied on `main` by commit `bcf2c54 recover: auto-supersede inbox item on
origin done/dropped/purged`. Documenting per repo precedent (`fdbb808`,
`a15bcf9`, `5989df3`).

## Acceptance criteria mapping

### 1. Origin task transitioning to `done` closes its inbox item without operator action

`orchestrator/src/mastra/daemon/server.ts`, inside `handleUpdate` after
`updateTask` flips the row, the `after.status === 'done'` branch calls:

```ts
const closed = await supersedeInboxItemsForOrigin(id, 'origin-done')
```

(`server.ts` ~lines 740–755). Errors are caught and logged so a failure
to supersede does not block the rest of the done-transition fan-out
(`onBlockerTaskCompleted`, `diagnose` follow-up, queued-dependents
emit). Tests cover the behaviour at the library boundary; see below.

### 2. Origin task transitioning to `dropped` closes its inbox item without operator action

`server.ts` `handleDrop`, after `dropTask(id)` returns (~lines 980–994):

```ts
const closed = await supersedeInboxItemsForOrigin(id, 'origin-dropped')
```

Wrapped in a try/catch identical in shape to the done path so a supersede
failure logs but still lets the drop response surface
`worktreeRemoved` / `branchDeleted` / `edgesRemoved` correctly.

### 3. `mars purge` on an origin task closes its inbox item without operator action

`server.ts` `handlePurge`, after the in-flight guard rejects (status must
already be `failed` or `done`) and `deleteTask(id)` removes the row
(~lines 894–920):

```ts
const closed = await supersedeInboxItemsForOrigin(id, 'origin-purged')
```

Same try/catch shape as the other two paths.

### 4. Supersede logic runs in the daemon, not in any renderer

`supersedeInboxItemsForOrigin` lives in
`orchestrator/src/mastra/lib/inbox.ts` and is only imported by
`orchestrator/src/mastra/daemon/server.ts`. No CLI / web UI / skill
renderer reaches into it; renderers read via `listInboxItems` (which
naturally filters by `state = 'open'`) and so observe rows vanish without
needing to know why.

Verified by `rg "supersedeInboxItemsForOrigin" orchestrator/src` — only
`lib/inbox.ts` (definition + test) and `daemon/server.ts` (call sites)
match.

### 5. Test simulates each terminal transition and asserts the item is no longer returned by inbox list

`orchestrator/src/mastra/lib/inbox.test.ts` has three sibling tests
(`origin task transitions to done` / `is dropped` / `is purged`) that
each:

1. raise an inbox item keyed by `originTaskId`;
2. call `supersedeInboxItemsForOrigin(originId, '<reason>')`;
3. assert `listInboxItems('open')` no longer contains the row;
4. assert `getInboxItem(id)` reports `state === 'resolved'`,
   `resolution === 'superseded'`, and a `resolutionNote` matching the
   reason.

Plus a no-op test (`supersedeInboxItemsForOrigin is a no-op when there is
no matching open row`) and a per-origin isolation test
(`only touches rows keyed to the given origin`).

## How the rows are keyed

`supersedeInboxItemsForOrigin` recomputes the origin-fingerprint
(`sha1("origin:" + originTaskId)`) and resolves every open row matching
it. Any recovery-descendant failure that named the same origin collapsed
into the SAME row at raise time (`raiseInboxItem`'s
`computeOriginFingerprint` branch when `originTaskId` is set), so closing
by origin id always closes the right row even after multiple recovery
attempts.

## Idempotency

Closing already-resolved rows is a silent no-op: the query filters
`state = 'open'`, so reruns against the same origin (e.g. a `done`
transition followed by a manual `mars purge`) just find no matches and
return `[]`. No duplicate history rows, no error.
