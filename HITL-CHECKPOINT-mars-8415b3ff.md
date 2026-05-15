# HITL checkpoint: clarify PRD `d5ed01ad-another-throwaway`

- **Parent PRD:** `d5ed01ad-another-throwaway`
- **PRD title:** `another throwaway`
- **PRD status:** `sliced` (auto-sliced by the daemon despite an empty body)
- **This task:** `mars-8415b3ff`, type `checkpoint` — pause for human
  verification before merge.

## Why this file exists

The PRD was sliced into a single HITL task whose explicit purpose is to
have a **human** decide what to do with a placeholder PRD that has no
problem, no solution, and no user stories (its title literally signals
"throwaway").

As the dispatched worker I am not the right actor to make that call:

- Filling in problem/solution/user stories on the user's behalf would
  fabricate intent.
- Closing the PRD as a throwaway on the user's behalf would dismiss
  potentially-real work.

Per the brief's "do NOT silently reinterpret" rule, I'm surfacing the
gap instead of papering over it. This file is the in-tree artifact that
makes the checkpoint visible to verify and to the reviewer; the actual
decision is recorded against the PRD via the `mars` CLI below.

## What the human needs to do

Pick exactly one path.

### Path A — fill in the PRD and re-slice

```sh
mars idea set d5ed01ad-another-throwaway problem  "<one-paragraph problem statement>"
mars idea set d5ed01ad-another-throwaway solution "<one-paragraph solution sketch>"
mars idea add-user-story d5ed01ad-another-throwaway "<first user story>"
# repeat add-user-story as needed
mars idea slice d5ed01ad-another-throwaway   # re-slice now that the body is non-empty
```

Then merge this checkpoint task — its acceptance criteria are satisfied
because the PRD now has Problem, Solution, and at least one user story.

### Path B — close the PRD as a throwaway

```sh
mars idea set    d5ed01ad-another-throwaway notes  "Closed as throwaway via HITL checkpoint mars-8415b3ff."
mars idea reject d5ed01ad-another-throwaway        # status -> 'dismissed'
```

Then merge this checkpoint task — every acceptance criterion is
satisfied by the "or is marked closed" branch.

## Acceptance-criteria mapping

| Criterion | Path A (filled) | Path B (closed) |
| --- | --- | --- |
| Non-empty Problem section | satisfied by `idea set problem` | satisfied by closed status |
| Non-empty Solution section | satisfied by `idea set solution` | satisfied by closed status |
| At least one user story | satisfied by `add-user-story` | satisfied by closed status |
| A decision is recorded | implicit in re-slicing | explicit via `idea reject` + notes |

## Decision recorded here

**Pending — awaiting human input.** No PRD-level mutation has been made
from this worker session. The orchestrator pauses on `checkpoint` tasks
before merge; this file is the diff that lets verify pass while the
substantive decision is taken out-of-band via one of the two command
blocks above.
