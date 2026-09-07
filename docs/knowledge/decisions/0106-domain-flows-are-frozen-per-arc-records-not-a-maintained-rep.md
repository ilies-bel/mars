# Domain Flows are frozen per-Arc records, not a maintained repo-wide domain model

Supersedes the immediately preceding ADR on partitioning Domain Timelines.
There is no durable, repo-wide domain model. A Domain Flow is authored during
an Arc's planning phase, attached to that Arc, and frozen at merge. It is
never refreshed, re-derived or reconciled.

Every maintenance cost we could not answer came from one claim: that the
artifact describes the CURRENT state of the target repository. Honouring that
claim requires re-derivation, which requires a trigger. Merge was the only
natural trigger and it fails: reverts, cherry-picks and rebases make
derive-from-HEAD non-monotonic, so a revert would spend a model call to
silently discard a still-valid human correction. Any other trigger is a
scheduled LLM job whose sole output is a diagram refresh.

A frozen Arc-scoped flow drops the claim and the cost with it. It asserts only
how the domain looked from inside one change, at the time that change was made,
which is true permanently. This is the same property that makes ADRs durable in
this repo while maintained context maps are the canonical abandoned DDD
artifact.

The cost we accept: with no global model, Mars cannot enforce an aggregate
boundary established in a different Arc, so DDD practice is enforced per-change
rather than repo-wide. A repo-wide view is not foreclosed; it becomes a read
derived on demand across the immutable flows, in the spirit of ADR-0094's
derived-on-read conditions, rather than a maintained artifact.
