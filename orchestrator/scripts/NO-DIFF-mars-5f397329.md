# No-diff acknowledgment: mars-5f397329

Task `mars-5f397329` ("Add an Inbox tab to ui/ alongside Kanban and
Todo…", branch `task/mars-5f397329`, signature `5d9f8e1a2f8ea1a1`)
failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

This is the latest in a long-running cluster of no-diff failures sharing
signature `5d9f8e1a2f8ea1a1` — see `NO-DIFF-mars-209eb596.md`,
`NO-DIFF-mars-00cc790e.md`, `NO-DIFF-mars-00cc790e-pass2.md`,
`NO-DIFF-mars-042440db.md`, `NO-DIFF-mars-74aa7403.md`,
`NO-DIFF-mars-883fbafe.md`, `NO-DIFF-mars-924033ce.md`,
`NO-DIFF-mars-08b123c5.md`, `NO-DIFF-mars-2989405d.md`,
`NO-DIFF-mars-e3c1704d.md`. Different upstream prompts, same
prompt-shape pathology under `MARS_CLAUDE_MAX_MESSAGES=100`.

The Inbox-tab prompt asks one `claude -p` session to deliver, in a
single dispatch, edits across at least seven loosely-coupled `ui/`
surfaces:

1. `ui/server/index.ts` — new `GET /api/inbox` endpoint
2. `ui/server/db.ts` — new `listInbox()` helper joining tasks +
   ideas
3. `ui/src/lib/api.ts` — new `fetchInbox()` client
4. `ui/src/hooks/useInbox.ts` — new hook modelled on `useTodo`
   (initial fetch + EventSource on `todo`/`tasks` events)
5. `ui/src/pages/InboxPage.tsx` — new page with three labelled
   sections + empty-state copy
6. `ui/src/components/NavBar.tsx` — new Inbox link after Todo
7. `ui/src/App.tsx` — new `#/inbox` hash route → `<InboxPage />`

Under the 100-message hard cap the agent reads each existing surface
(NavBar, App, useTodo, server/index.ts, server/db.ts, api.ts) to
mirror conventions, plans the new files, then runs out of message
turns before emitting any edit. This is **prompt-shape**, not a
code-level fix the orchestrator can heal.

## Recommendation

Drop `mars-5f397329` and re-enqueue as a **3-way split** along the
client/server seam:

1. **Server: `/api/inbox` endpoint + `listInbox()`.** Add the helper
   in `ui/server/db.ts` (single SELECT over `tasks` filtered by
   `status IN ('blocked','failed')` plus the existing draft-ideas
   query that `/api/todo` already uses; reuse `rowToTask`). Wire
   `GET /api/inbox` in `ui/server/index.ts` returning
   `{ drafts, blocked, failed }`. No client work. Verify with a
   curl-style test or a tiny endpoint test if `ui/server` already
   has them; otherwise just typecheck.

2. **Client data layer: `fetchInbox()` + `useInbox` hook.** Add
   `fetchInbox()` to `ui/src/lib/api.ts` (mirror existing API
   shapes). Add `ui/src/hooks/useInbox.ts` modelled on `useTodo` —
   initial fetch + EventSource subscribing to existing `todo` and
   `tasks` events (no new event names). Typecheck only — page not
   wired yet.

3. **Page + nav wiring.** Create
   `ui/src/pages/InboxPage.tsx` rendering three labelled sections
   (Drafts / Blocked / Failed) with empty-state copy. Add Inbox
   link after Todo in `ui/src/components/NavBar.tsx`. Add
   `#/inbox` → `<InboxPage />` in `ui/src/App.tsx`. Manual
   verify: open ui/, click Inbox, confirm three sections render.

Each slice fits comfortably under one `claude -p` budget. Step 1 is
strictly server-side and compiles independently. Step 2 only needs
step 1's endpoint shape (defined in step 1's TypeScript). Step 3
only consumes step 2's hook.

## Why no code change in this commit

This worktree (`task/bea7c024`) is a **fix-fail recovery** dispatch
on top of the original failed feature run. The feature itself
produced no diff, so there is nothing concrete for the recovery
dispatch to "fix" — the correct response is to acknowledge the
no-diff with a tracked record (this file) and let the operator
re-shape the work into smaller slices. Attempting yet another
monolithic retry would burn another no-diff session to the same
root cause.

Filed as a paper-trail commit so the failure signature
`5d9f8e1a2f8ea1a1` is visible in `git log` next to its siblings.

## Meta-observation

Ten+ no-diff failures with this signature is no longer noise — it is
the dominant failure mode. The fix-fail handler should learn this
shape and route signature `5d9f8e1a2f8ea1a1` directly to the human
inbox after the first failure, instead of dispatching another
worktree-and-`claude -p` round whose only output is one of these
acknowledgement files. Tracked separately as a follow-up — see
recent self-heal commits (e.g. `779411e`, `31cdeeb`) recommending
the same two-strikes drop-and-reshape policy.
