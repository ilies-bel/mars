# Action-Queue Recipe Audit

One source of truth for human-language copy and action verbs for every
action-queue kind. The machine-readable version lives in
`orchestrator/src/core/lib/action-queue-recipes.ts`; this doc exists so
copy can be reviewed and refined in one place.

Column legend:
- **Human sentence** — `humanSummary`: one plain sentence for the card headline.
- **Primary verbs** — the op-labelled buttons shown before Dismiss / Snooze.
- Notes — copy rationale or payload dependencies.

> Every kind additionally gets **[Dismiss]** and **[Snooze]** appended
> automatically. Presets ("1 h", "tomorrow") are handled client-side; the
> API accepts an absolute ISO-8601 timestamp.

---

## Task failures

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `failed` | "A task got stuck and Mars used up its retry — decide what to do with it (`<taskId>`)." | [Restart] [Discard task] | taskId from payload or entityId |
| `cancelled-blocker-cascade` | "A blocker task was cancelled and Mars cancelled its dependents too — review which tasks were affected." | [Restart chain] | |
| `diagnose-inconclusive` | "Mars tried to diagnose a failure but could not find a clear root cause — manual investigation is needed." | [Investigate] | |
| `daemon-killed` | "The background engine was stopped while tasks were running — those tasks need to be restarted." | [Restart all affected] | |
| `phantom-task` | "A task was marked as running but the background process no longer exists — Mars auto-failed it and the slot is free again." | [Restart] | |
| `orphaned-origin` | "A blocked task's origin task was deleted — the dependent is stuck and needs to be resolved manually." | [Discard task] | |

## Worktree issues

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `stale-worktree` | "A task's working copy has uncommitted changes that are just sitting there — clean it up or resume it (`<taskId>`)." | [Clean up worktree] | |
| `worktree-ahead` | "A task's working copy has commits that were never merged — merge or discard them (`<entityId>`)." | [Discard unmerged work] | |
| `prerequisite-failed` | "A prerequisite check failed before a task could start — fix the underlying issue first." | [Retry] | |
| `done-with-unmerged-commits` | "A task was marked done but its code was never merged into main — investigate and re-merge (`<entityId>`)." | [Re-attempt merge] | |

## Proposals and planning

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `draft-proposal` | "A new proposal is waiting for your review: \"<title>\"." | [Shape into PRD] [Promote & enqueue] | title from payload |
| `slices-dropped` | "Some tasks were removed from the plan because they were out of scope or redundant — check what was dropped." | (none) | Dismiss / Snooze only |
| `hitl-slice-needs-operator` | "A task in the plan requires a human to take over — attach to it and do the work manually." | [Attach & work] | |

## Human-in-the-loop

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `awaiting-validation` | "A task finished and its preview is ready for you to check — validate it to merge, or reject to restart." | [Validate & merge] [Reject] | |
| `awaiting-human` | "`<leaseOwner>` is working interactively on a task — it will resume automatically when the lease is released." | (none) | leaseOwner from payload |

## Verification

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `behaviour-unverified` | "A task was merged but Mars could not check it actually works — follow the linked proposal to verify manually." | (none) | |
| `arc-verification-failed` | "Post-merge verification found that an arc's goals were not satisfied — investigate and fix the output or mark it resolved." | [Investigate] | |

## Daemon and infrastructure

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `daemon-died` | "The background engine crashed unexpectedly — restart it to resume normal operation." | [Restart engine] | Compound op |
| `daemon-code-drift` | "The background engine is running old code — restart it to pick up your latest changes." | [Restart engine] | Compound op |
| `subscriber-stalled` | "An internal event processor keeps failing on the same event and has stopped — fix the underlying error to unblock it." | (none) | |
| `observability-store-oversize` | "The observability database has grown past 500 MB — prune it to free disk space." | [Prune store] | |
| `outbox-lag` | "An event queue is backed up — a subscriber may be wedged. Check the subscriber status." | (none) | |

## API and rate limits

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `api-outage` | "The Claude API is down — tasks are paused automatically and will resume once the API recovers." | (none) | Auto-resolves |
| `provider-rate-limited` | "The Claude API rate limit was hit — dispatch will resume automatically at `<resetsAt>`." | (none) | resetsAt from payload; generic fallback if absent |

## Reflection and evolution

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `reflect-recommended` | "Mars spotted patterns worth reflecting on — run a reflection to surface improvement proposals." | [Run reflection] | |

## Verify gates

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `gate-broken` | "A verify gate keeps failing the same way (\"<verdict>\") — the gate itself may be broken, not the tasks." | (none) | verdict from payload; generic fallback if absent |
| `gate-enrichment` | "A new failure pattern was spotted — review the proposed gate check and approve it or retire the pattern." | [Approve gate check] [Retire pattern] | |

## Budget

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `budget-window` | "Spending in the current time window has crossed the warning threshold — no tasks are paused, but keep an eye on it." | (none) | Observe-and-warn only |
| `budget-arc` | "An arc's spending crossed the per-arc ceiling — work is still running, but review it (arc `<arcId>`)." | (none) | arcId from payload |

## Quality and workflows

| Kind | Human sentence | Primary verbs | Notes |
|---|---|---|---|
| `scorer-suggested` | "Mars suggested a quality scorer for the \"<workflowName>\" workflow — accept it to start tracking quality automatically." | [Accept scorer] [Dismiss suggestion] | workflowName from payload |
| `promotion-decision` | "The \"<workflowName>\" workflow is performing better/worse than before — promote it / consider retiring it." | [Promote] [Retire] | verdict from payload drives copy |
| `workflow-draft-pending` | "A self-authored workflow \"<name>\" is waiting for your approval before it can be dispatched." | [Approve workflow] | workflowName from payload |
| `tool-promotion` | "A helper tool \"<helperKey>\" has benchmark evidence ready — review and promote or reject it." | [Promote helper] [Reject helper] | helperKey from payload |

---

## Snooze behaviour

- `POST /actions/snooze/:id { until: "<ISO-8601>" }` sets `snoozed_until`
  in `action_queue_items`.
- Snoozed rows are filtered out of the open view (`/view/action-queue`)
  and chat alert segments until `snoozed_until ≤ now`.
- No wake-up mechanism is needed: the filter reapplies on every poll.
- Presets ("1 hour", "end of day", "tomorrow") are resolved to an
  absolute ISO-8601 timestamp client-side before calling the API.
- Dismiss (`POST /actions/dismiss/:id`) uses the existing dismissal path
  (sets `state = 'resolved'`).
