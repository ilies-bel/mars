# Notifier subscribes to action-queue.raised only, not task.failed

The Notifier fires on action-queue.raised and deliberately does NOT subscribe to task.failed. Rationale: action-queue rows are keyed on resolved origin_id (ADR-0051), so one failing arc raises exactly one row regardless of how many recovery attempts fail — yielding one notification per distinct arc for free. task.failed fires per-attempt and would re-notify on every retry. Trade-off accepted: the operator is not pinged per-retry, only when a fresh alert row is raised.
