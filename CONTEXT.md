# Project Context

Canonical domain terms for this project. Edited via `mars glossary`.

## Language

**Idea**:
A draft of work to do, persisted in .mars/state.db, regardless of who proposed it; every Idea carries a source — reflection (synthesized by mars reflect / deep-reflect from past task signals), human (created by the user), or planner (raised by the planner agent when it spots a gap while refining another Idea).
_Avoid_: suggestion

**TODO page**:
The single read-only ui/ view that lists every item awaiting human attention: ideas to refine (the unified ideas bucket) and blocked tasks from queue.db; users act via the CLI, never via the page.

**originId**:
Tracer id for a full workflow from `mars idea add` (or `mars task add`) through to merge; propagated onto every Mastra span in the arc so `mars deep-reflect` can analyze the whole workflow as one timeline.
