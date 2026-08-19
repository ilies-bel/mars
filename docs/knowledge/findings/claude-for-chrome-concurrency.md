# Finding: Claude for Chrome serializes browser operations

**Task:** mars-7f2de34d · **Date:** 2026-08-19 · **Status:** decided

## Question

Can multiple Mars agents drive one Claude for Chrome extension instance
concurrently, each in its own tab group — or does the extension serialize?

The planned browser-automation design deliberately ships with **no queue**:
agents get a tab group each and run concurrently. This spike tests whether
that decision holds.

## Answer

**It does not hold. The extension serializes browser operations, and the
serialization is total.**

Two operations issued in parallel, against two different tabs in the same
group, did not overlap at all. The second did not begin until ~2.2 s *after*
the first had finished.

## Probe 1 — tab-scoped concurrency

Two tabs in one group (`example.com`, `example.org`). Each ran an in-page
timer recording `Date.now()` before and after a fixed sleep. Both calls were
issued in a single parallel batch.

**Trial 1 — 3000 ms sleep each**

| tab | t0 | t1 | duration |
|---|---|---|---|
| A | 1787175402448 | 1787175406267 | 3819 ms |
| B | 1787175408466 | 1787175412268 | 3802 ms |

B started 2199 ms after A ended. Intervals disjoint. Wall clock ≈ 9.8 s.

**Trial 2 — 1000 ms sleep each**

| tab | t0 | t1 | duration |
|---|---|---|---|
| A | 1787175422547 | 1787175424268 | 1721 ms |
| B | 1787175426462 | 1787175428268 | 1806 ms |

B started 2194 ms after A ended. Intervals disjoint.

**Reading.** The inter-operation gap is 2199 ms then 2194 ms — a fixed
dispatch cost, not jitter or contention. In-call overhead is a further
~720–800 ms (a 1000 ms sleep occupies ~1721 ms of page time). So every
browser operation carries roughly **3 s of pure overhead, fully serialized**.

Ten agents doing ten browser steps each is not ten concurrent streams. It is
one stream, one hundred operations deep, at ~3 s of overhead apiece — about
five minutes of dispatch cost before any real work.

## Probe 2 — foreground contention

Not reached, and now moot. Contention was the hypothesis for `computer`-class
calls specifically, on the theory that tab-scoped work would run free. Probe 1
refutes the premise: even `javascript_tool` and `read_page` — pure tab-scoped
calls that touch no viewport — serialize completely. There is no concurrent
tier to protect.

## Probe 3 — tab group identity

Superseded by a stronger finding read directly off the tool contract, which
made the restart test unnecessary:

- `tabs_context_mcp` returns **"the current MCP tab group"** — singular,
  session-scoped. Our group id (`934118`) was assigned, not chosen.
- `tabs_create_mcp` **takes no arguments**. It creates a tab in *the* session's
  group. There is no parameter to name or select a group.
- `tabs_close_mcp` operates only on "this session's group".
- The tool docs state tab ids must never be reused across sessions.

**There is no named-tab-group API.** Mars cannot create or address a group
called `mars-<task-id>`. A group is an implicit, session-scoped artifact.

This kills the "group name as durable identity, tab id as cache" contract
proposed during design. Identity is the **MCP session**, which Mars does not
name and cannot reattach to.

## Probe 4 — dialog shared-fate

**Not run, deliberately.** A JS dialog is documented to block all further
browser events and stop the extension receiving commands, recoverable only by
manual dismissal in the operator's live browser. Probe 1 already settles the
design question, so the marginal information did not justify wedging a
browser someone is working in. Left as a known, untested hazard.

## Residual unknown

Probe 1 measured serialization **within one MCP session**. It did not test
whether *separate* sessions — the actual "one agent, one connection" shape —
serialize against each other.

This is not a loophole to plan around. The measured cost is a fixed ~2.2 s
gap, which reads as a single dispatch channel into one extension instance;
that channel is very unlikely to be per-session. But it is untested, and
testing it needs two independent MCP clients against one browser. **Run that
before building anything that assumes per-session concurrency.**

## Consequence for the design

The no-queue decision was made to avoid over-serializing. The measurement
shows there is nothing to over-serialize: **an implicit queue already exists
inside the extension.** Shipping without an explicit one does not buy
concurrency. It buys the same serialization with none of the visibility,
fairness, timeout handling, or attributable failure signatures — exactly the
outcome the spike was meant to rule out.

The earlier hypothesis — a narrow *foreground lease* over `computer`-class
calls only — is also wrong, and wrong in the permissive direction. The
boundary is not the viewport. It is the extension itself.

Three options follow, in the order they should be considered:

1. **Make the queue explicit and own the ordering.** One in-flight browser
   operation, Mars-side, with depth and wait time visible and a timeout. Costs
   nothing in throughput — that throughput does not exist — and buys back
   observability and fair scheduling. Recommended.
2. **Re-scope browser work to be rare.** At ~3 s per operation, browser
   automation cannot be a routine step in a parallel fleet. It suits
   occasional attended tasks, not the general automation path.
3. **Use a different runner for unattended work** (Playwright with its own
   profile) and keep the extension for attended, human-present steps where its
   site-permission model is the point. Costs the borrowed-session property
   that motivated the extension in the first place.

Whichever is chosen, the tab-group-per-agent model does not survive contact
with the API: there is no way to create one.

## Method note

All timings came from `Date.now()` **inside the page**, not from wall-clock
timing of the tool calls, so harness and network latency are excluded. The
disjoint-interval result is a property of the extension's own dispatch.
