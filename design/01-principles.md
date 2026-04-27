# 01 — UI Principles (locked)

These constrain every later decision. Lock them now so view drafts don't
re-litigate posture.

## 1. Read-only, always

The UI never mutates Mars state. No buttons that POST. No forms. No
"approve" / "dismiss" controls. The CLI is the only control surface —
restating VISION's locked decision so the UI design can't drift.

When the user wants to act, the UI shows the **exact CLI command** to copy:

```
This task is parked on inbox item 7f3a91c2-needs-scope.
$ mars answer 7f3a91c2 "<your answer>"
```

This keeps the CLI sovereign and turns the UI into a teaching surface for
the CLI rather than a competing control plane.

## 2. One shell, three views

Topology, Runs, Run-detail. No fourth view in v0. If a question can't be
answered from one of these three, the answer probably belongs in
`mars logs` / `mars trace` — extend the CLI, not the UI.

## 3. Files are the contract, not an API

The UI reads:

- `mars.flow.ts` (resolved at boot) → topology
- `.mars/db/events.db` → live + past run timelines
- `.mars/db/metrics.db` → run-level aggregates
- `.mars/inbox.jsonl` → footer counts + parked-task affordance

There is no Mars-server REST API to design. The Hono server exposes one
SSE endpoint (`/api/events`) and a handful of read-only JSON endpoints
that are thin shims over the files above. Adding a new view means
reading the file, not extending an API contract.

## 4. Live and historical use the same component

A "live" run is just an event stream that hasn't ended. A "past" run is
the same shape replayed from disk. The timeline view doesn't branch on
liveness — it consumes events and renders. This is what makes the SSE
stub viable (`runs/<ts>/events.jsonl` + `db/events.db` agree on shape).

## 5. Density over chrome

Solo-dev tool. No empty hero sections, no breadcrumbs that restate the
URL, no "welcome to Mars" cards. The first paint must show data. If
there's no data yet, show the CLI command that produces it:

```
No runs yet.
$ mars build
```

## 6. Token meter is first-class

Every view that shows agent activity shows tokens used. Cost is the
anti-goal that justifies the whole observability stack — never bury it
in a tooltip.

## 7. No notifications, no settings page

- Notifications are deferred (`CONTRACTS.md` §6.8). Don't add a bell icon.
- Settings live in `mars.config.ts`. The UI may *display* the resolved
  config (read-only) but never edit it.
