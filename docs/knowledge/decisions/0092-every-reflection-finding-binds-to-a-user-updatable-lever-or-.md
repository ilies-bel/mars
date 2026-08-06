# Every reflection finding binds to a user-updatable lever or declares a lever gap

## Context

Reflection is an end-user surface. `mars reflect`, `mars arc reflect`, the
failure-reflector, and the scoring low-trend trigger all produce findings that
land in front of an operator as draft proposals.

Today those findings are free prose. A suggestion says "make worker dependency
bootstrap idempotent" or "gate hard cuts with integration contracts" and stops
there. The operator is left to translate an observation into an action, and
the only action the product offers them is "file a code task" — which routes
the finding back into the same pipeline that produced it.

Meanwhile Mars already exposes a substantial set of parameters the user can
turn: worker model and effort (`mars worker add --model --effort`), the
provider (`defaultProvider`), workflow selection per task (`--workflow`) and
workflow definitions (`.mars/workflows/`), verify gates (`mars verify add`),
concurrency caps, the operator control levers (`mars operator set`), spend
budgets, scorers (`mars scorer accept`), and the per-task spec fields
(`--files/--verify/--done/--merge/--priority/--tag`).

`orchestrator/src/core/lib/improvement-recipes.ts` already demonstrates the
right shape for one family: each recipe carries `setupSteps` containing the
literal CLI gesture that applies it. But the catalog covers only verify gates,
and only the failure-reflector consumes it. The two reflectors that produce
most findings emit unbound prose.

The consequence is that reflection describes problems in a vocabulary that
does not map onto anything the user can change.

## Decision

Every reflection finding must resolve to exactly one of two outcomes:

1. **A lever binding** — a reference to an entry in a canonical lever
   registry, with the current value and the proposed value. The registry entry
   carries the gesture that applies it, so the finding is actionable without
   translation.

2. **A declared lever gap** — an explicit statement that no user-updatable
   parameter can express the change, naming what the parameter would be if it
   existed.

A finding that produces neither is rejected, not filed.

Lever gaps are treated as first-class product output rather than as failures
of the reflector. They are the system's own account of where it is not
manageable, aggregated into a backlog of missing controls.

## Consequences

**Constraining.** Reflectors can no longer say anything they like. Some
genuine observations do not correspond to a knob and will be filed as gaps
rather than as suggestions, which is a narrower channel than free prose. This
is intended: an observation nobody can act on is not yet a finding.

**The registry becomes a contract.** Every lever family needs a registry entry
with a working read path and a working gesture. This exposes that several
parameters are currently readable but not settable at runtime — `caps.*`,
`defaultProvider`, `selfEvolve.taskConfidenceThreshold`,
`selfEvolve.driftThresholdPct`, and the `scoring.*` trio can only be changed
by hand-editing `.mars/daemon.json` or setting an env var before daemon start.
Those gestures have to be built for the registry to be honest.

**Reflection output becomes renderable.** A bound finding has a fixed shape —
lever, current, proposed, gesture — so the interface can show it as a control
rather than as a paragraph, and can show what the operator would be changing
before they change it.

**Alternative rejected: keep prose, add a lever hint.** An optional field
would be populated when convenient and skipped under load, which is exactly
how `rootCauseKey` — optional, model-supplied — ended up present on 1 of 176
reflection proposals, leaving the deduplication path it gated unreachable.
Optional metadata that the pipeline depends on does not survive contact with a
model. The binding is required or it is not real.
