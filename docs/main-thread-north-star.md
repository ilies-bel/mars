# North star — the main thread is a conversation

Mars is proactive but mainly reactive. Every unprompted thing Mars does to the
operator's machine, budget, or repository, Mars says out loud in the main
thread — once, in plain language, as a card that carries the lever which caused
it. The message and the off-switch are the same object.

## The six use cases this must serve

1. **New session, all clear.** "Nothing on my side — want to grill a proposal?"
   with the next draft proposal offered.
2. **Autonomous change, announced.** "I changed the load from 12 to 3 workers,
   your Mac CPU was strained." → `[Noted]` `[Stop doing this automatically]`
3. **Suggestion with a reference.** "You don't use graph traversal; installing
   codegraph will cut my token spend." → `[Install it]` `[Later]`
   `[Don't ask again]` `[Why AST traversal helps ↗]`
4. **Behavioural observation.** "I noticed you keep pushing manually into the
   pipeline."
5. **Trend plus report.** "Token spend rose lately; the architecture looks
   tangled. Here's a report." → `[Implement it]` `[Don't do that again]`
6. **Mid-session interjection.** While the operator is in a grilling Subject:
   "btw I changed the load to 2 workers, a failing test on main is breaking
   every incoming feature, I paused the framework while I sort it out."

Plus: **when a Subject closes, its outcome folds back into the main thread as a
Context line, and the next Subject is offered.**

## Invariants

- A Notice is **zero-token**. No provider run, ever.
- A Notice **never takes the floor**: routine notices wait for a pause, urgent
  ones land immediately but do not interrupt a run.
- A Notice is **never silently dropped**. If it cannot be delivered it stays
  pending and is retried — regardless of priority.
- Every autonomous behaviour is reachable by an **Autonomy level** lever
  (`off` / `ask` / `tell`), and the notice announcing it names that lever.
- Chips are an **affordance over an Offer set**, not the only way in. Free text
  the operator types is matched against the open Offer set before it is
  treated as a new Subject.

## Contract — shared shapes (implement to this exactly)

### `PreloadedResponse.target` — extended union

Defined in `orchestrator/src/core/lib/chat-store.ts` (`PreloadedResponseSchema`)
and mirrored in `ui/src/shared/schemas.ts` (`preloadedResponseSchema`). Both
must stay in lockstep.

```ts
target =
  | { type: 'verb';      op: string; entityId?: string }
  | { type: 'subthread'; title: string }
  | { type: 'client';    op: 'open-proposal-subject'; entityId: string }
  | { type: 'lever';     name: string; level: 'off' | 'ask' | 'tell' }
  | { type: 'reference'; url: string }
  | { type: 'ack' }
```

`ack` was not in the first draft of this contract and had to be added: use
case 2 offers `[Noted]`, and without it the only way to close an FYI would
have been to silence the behaviour behind it — which is the opposite of what
"noted" means.

The orchestrator's `client` branch was also missing before this work, so a
stored `client` chip made `getPreloadedResponse` skip the whole segment and
return 404. Both schemas now carry all six.

- `lever` → server writes `persistLeverAutonomyLevel(name, level)` and echoes
  the chip label back as a `context_scope='main'` user message, exactly as the
  `verb` branch does today.
- `reference` → **client-only**. Opens `url` in a new tab. Never hits the
  network. `url` must be `https:` — reject anything else at parse time.

### The main thread sentinel

One well-known `chat_threads` row:

```
id         = 'main'
title      = 'Main thread'
origin     = 'main'
closed_at  = NULL   (permanently)
```

Seeded idempotently at schema-ensure time. It is the delivery target of last
resort, so a Notice can never park for want of an open thread.

It must be excluded from:
- `listThreads` (it is not a Subject and must not appear in the sidebar)
- `listSubthreadBoundaries` (it must not emit a boundary line)
- `deliverPendingNotice`'s "most recently touched open thread" lookup, which
  would otherwise always select it

### Delivery targeting

```
if (a run is active on some Subject)  -> deliver to that Subject   // use case 6
else                                  -> deliver to 'main'
```

Either way the message is written with `context_scope='main'`, so it appears in
the main feed regardless of which row it hangs on. This is the existing
semantics (`chat-store.ts:993` selects the feed as
`WHERE context_scope='main' OR kind='situation'`) — we are only fixing the
target, not inventing a new scope.

### Notice kind registry

`orchestrator/src/core/lib/conversation-copy.ts` becomes the single place that
maps a notice kind to its three facets:

```ts
{ render(payload): string          // first-person body copy
  lever?: string                   // the autonomy lever that produced it
  offers(payload): PreloadedResponse[] }
```

`conversation-delivery.ts` must stop hard-coding `[{type:'text'}]` for the
`{kind,payload}` branch (currently lines 90-92) and carry the registry's offers
through to the stored segments.

### Live arrival

Three gaps to close so a notice appears without a refetch:

1. `conversation-delivery.ts` broadcasts `viewStreamHub.broadcast('chat')`
   after a successful delivery.
2. `ui/src/shared/SseInvalidator.tsx` adds `['chat-conversation']` to the
   queries invalidated on a `chat` event.
3. The main feed renders a newly-arrived notice with simulated typing.

### Simulated typing

Notices are pre-written strings, not streams. They must *read* as speech.
Reveal the body character-by-character on first appearance only; a notice
already present on mount renders complete, with no animation. Respect
`prefers-reduced-motion` — that means render instantly.

Typing must never gate the chips: the Offer set renders once the body
completes, and the whole message is already durable in the DB before the first
character appears.

## What each use case is built from

Every Notice is only as honest as the evidence behind it. Where the faithful
signal did not exist, this records what was measured instead.

| | Detector | Evidence |
|---|---|---|
| 1 | `detectIdleProposal` | no task in `queued`/`running`/`blocked`, plus the oldest draft proposal never yet offered (checked against the feed itself) |
| 2 | `steward-runtime-tune` | already existed; now gated on `steward_runtime_tune` and written to the Steward ledger |
| 3 | `detectCodegraphSuggestion` | no traversal MCP server in `.mcp.json`/settings, no codegraph call in `mcp_worker_audit`, and ≥25 tasks completed in the window |
| 4 | `detectManualPush` | commits on the integration branch that no `merge_jobs.merged_sha` accounts for |
| 5 | `detectTokenSpendTrend` | `usage_snapshots` — recent window vs the window before it |
| 6 | `announceBrokenGate` | the dispatch pause controller, `reason: 'storm'` |

Two of these required new evidence rather than new copy:

- **Use case 4** had no way to tell Mars's commits from the operator's — both
  carry the operator's git identity. `merge_jobs.merged_sha` was added and is
  written by the merge worker. Until a merge records one, the detector stays
  silent: an empty ledger is not evidence that the operator did it all by hand.
- **Use case 3** claims a token cost. Mars cannot count a Worker's file reads
  — that happens inside the provider CLI — so the copy counts the Workers it
  sent in without an index instead, which is what it can actually see.

Use case 5's original wording ("here is a report") would have described a
report nothing writes. The Notice reports the measured trend and offers to go
find the cause.
