# Every failure signature must have a recovery recipe

When a task fails inside the orchestrator's implement workflow, the failing
step plus the normalized error are mapped to a human-readable **failure
signature** (a technical key, e.g. `verify:has-diff/no-commits-ahead`,
`merge:dirty-target`, `setup:install-failed`) and the orchestrator looks up a
**recovery recipe** registered under that signature. The recipe alone builds
the recovery task's prompt — the previous generic "Fix the failure that blocked
task X" prompt is removed. **Recovery tasks have a retry budget of zero**: a
failed recovery does NOT spawn another recovery, it raises an inbox item with
`kind='recovery-failed'` and leaves the original task `blocked` for a human
decision (`mars retry <recovery-id>`, `mars unblock <origin-id>`, or fix the
upstream cause). When a failure produces a signature that has no recipe, the
orchestrator does NOT enqueue a generic recovery; instead it raises an inbox
item with `kind='no-recipe'` and dispatches an **Investigator** agent whose
sole job is to inspect the failure and submit a draft recipe for maintainer
review — the failing task itself stays `blocked` until that recipe lands.
Chosen because the cascade we hit on 2026-05-10 (one `verify:has-diff` failure
fanned out into an exponential cloud of generic-prompt recovery tasks across
multiple daemons) was a direct consequence of letting any failure escalate
behind a hand-wavy prompt; binding escalation to a curated registry forces
every failure mode to be either fixable by a specific recipe or visibly
traceable in the inbox + investigator queue. Trade-off: every new failure
signature now requires a code change to the recipe registry — recipes cannot
be auto-generated from error text without sliding back into the cascade
pattern, so the Investigator agent produces only a *draft* recipe that a
human merges. Cost: the first occurrence of a new failure mode parks the
original task in `blocked`/`failed` and a draft recipe lands in the inbox;
accepted because the alternative is unbounded fan-out under generic prompts.
