# Domain Timelines are partitioned into named flows, not one global chronological wall

A Domain Timeline is partitioned into named Domain Flows, not into one global
chronological wall cut by Pivotal Events as in a classical Brandolini event
storm. A codebase has no single global clock, so a repo-wide chronology across
unrelated processes such as signup, checkout and refund would be fiction, and
inventing it is not derivable from code.

The cost is that bounded-context boundaries are no longer free: in a classical
storm the vertical cuts at Pivotal Events give them to you directly. Here,
Pivotal Events are marked WITHIN a flow, and boundaries must instead be derived
later by clustering the Domain Events and aggregates that recur across flows.

We accept that cost deliberately, for the same reason aggregates are deferred:
a boundary declared before there is a corrected timeline to cluster is a guess,
and a guessed boundary is how this repo ended up with a single god aggregate.
Named flows are derivable from a target repo's code on the first pass; the
boundary map becomes a later clustering pass over real, human-corrected data.
