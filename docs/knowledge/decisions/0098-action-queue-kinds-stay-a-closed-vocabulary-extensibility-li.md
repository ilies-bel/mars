# Action-queue kinds stay a closed vocabulary; extensibility lives in payloads

# Action-queue kinds stay a closed vocabulary; extensibility lives in payloads

## Status
Accepted

## Context
The modular-core program (see ADR on cordis Ports) makes every module
boundary swappable and most vocabularies open (ProviderName and WorkerName
were deliberately opened to `string`). `ACTION_QUEUE_KINDS`
(`core/lib/action-queue-kinds.ts`, ~60 string literals) is the largest
remaining closed union, and the obvious move under the pillar would be a
`registerActionQueueKind()` registry. But the action queue is the single
human-facing work surface: every kind must be renderable by the UI and CLI
and dispatchable to a resolver (/mars:unblock, /mars:grill, terminal verbs).
A row of an unknown kind that a human cannot act on is worse than no row.

## Decision
The kind vocabulary stays closed and curated — adding a kind is a deliberate
product-design act, like adding a page to a UI, not a plugin registration.
Extensibility moves one level down: plugins and Ports raise rows of an
existing kind, using self-describing payloads (title, body, offered verbs)
so new sources of operator work need no new kind. This applies to both row
families of ADR-0094: condition kinds remain derived-on-read; operator-
decision kinds remain stored rows with authored content.

## Consequences
- Human renderability and resolver coverage are guaranteed by construction;
  the UI and resolver skills never meet an unknown kind.
- This is a recorded exception to the "open every vocabulary" instinct; do
  not convert `ACTION_QUEUE_KINDS` to an open registry.
- A Port that needs to surface novel operator work uses a generic
  operator-decision kind with a self-describing payload; if that payload
  pattern recurs, promoting it to a first-class kind is the curated path.
