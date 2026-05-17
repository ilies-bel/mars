# Rename idea to proposal

## Context

The domain term "idea" was overloaded: in early Mars it meant a draft of work to do, regardless of who proposed it (user, reflection, planner). "Idea" reads as casual and human-centric, but the entity is now a first-class workflow noun with a typed source field and structured grilling lifecycle. The CLI verb `mars idea add` and the table name `ideas` made the casual reading stick.

## Decision

Rename the entity from "Idea" to "Proposal" everywhere: CLI verb (`mars proposal add`), glossary, prose in CLAUDE.md, skills and orchestrator briefs going forward. Avoid the words "idea" and "suggestion" in new docs.

## Consequences

- `mars idea …` no longer exists; `mars proposal …` is the sole verb. Per project policy (every change is a hard cut), no alias is kept.
- The glossary term "Idea" is removed; "Proposal" replaces it with the same definition.
- Existing ADRs (0001, 0006, 0008, 0010, 0015) keep their original "idea" wording as historical record. Future ADRs use "proposal".
- DB-level rename of the `ideas` table and `source` enum values is tracked in the parent PRD's earlier slices; this ADR records the naming decision itself.
