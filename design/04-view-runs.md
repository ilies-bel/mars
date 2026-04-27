# 04 — View 2: Runs

Flat list of past + live runs. The "did anything just happen?" view.

## Wireframe

```
┌─────────────────────────────────────────────────────────────────────────┐
│  RUNS                                          50 kept · `--keep` to pin│
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ● live   2026-04-27 14:22  · add oauth callback                        │
│           1m 04s · 3 agents · 24k tokens · inbox +0                     │
│  ─────────────────────────────────────────────────────────────────      │
│   ✓ done  2026-04-27 13:08  · refactor planstore beads adapter          │
│           4m 41s · 7 agents · 142k tokens · 3 tasks · inbox +1          │
│  ─────────────────────────────────────────────────────────────────      │
│   ⚑ halt  2026-04-27 11:54  · add inbox priority recompute              │
│           58s · 1 agent  · 18k tokens · halted: ambiguous_prompt        │
│  ─────────────────────────────────────────────────────────────────      │
│   ✓ done  2026-04-27 10:15  · markdown compiler skeleton          📌    │
│           2m 12s · 4 agents · 81k tokens · 2 tasks · inbox +0           │
│  ─────────────────────────────────────────────────────────────────      │
│   ✗ fail  2026-04-26 22:03  · vcs adapter conflict path                 │
│           23s · 1 agent  · 9k tokens · failed: vcs_conflict             │
│                                                                         │
│  …                                                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

## Row anatomy

```
[status]   [timestamp]              · [goal — first 60 chars]
           [duration] · [agents] · [tokens] · [tasks] · [inbox delta]   [pin]
```

- **status icon** — `●` live, `✓` done, `⚑` halted, `✗` failed.
- **timestamp** — ISO local time; click to deep-link the run.
- **goal** — first line of `Plan.goal` for the run; truncates with
  ellipsis, full text on hover.
- **stats** — pulled from `metrics.db`. Tokens is bold-weighted; it's the
  number that pays.
- **inbox delta** — `+N` if this run added items to the inbox; `0`
  greyed. Lets you spot retro-worthy runs at a glance.
- **pin** — `📌` if the run was started with `--keep` (CONTRACTS §11.1).
  Pinned runs are exempt from the 50-run rotation.

## Filters

A single text filter, top-right. No facet sidebar.

```
filter:  [ status:halted goal:auth                          ]   [ clear ]
```

Tokens recognized: `status:`, `goal:`, `since:24h`, `tokens:>50k`. Everything
else is a goal substring match. Lean — extending the filter language is a
two-line `parseFilter()` change.

## Sort

Always reverse-chronological. No sort dropdown. If you want budget
order, use `mars audit`.

## Live row

The top row when an SSE connection is open and a run is active. It
animates the duration counter and the tokens counter live; status icon
pulses. Click → View 3.

## Empty state

```
No runs yet.
Start one with:
   $ mars build
```

That's it — no illustration, no onboarding flow.

## Rotation hint

Header says `50 kept · --keep to pin`. Hovering reveals: "Older runs are
deleted on `mars build` start unless pinned." The hint exists because
losing a useful run to rotation is annoying enough once that the cure is
to surface the existence of `--keep`.
