# KPI

One of a small fixed vector of read-only health numbers derived from completed Arcs over a rolling time window, surfaced on the dashboard so the operator can spot orchestrator drift at a glance. KPIs are defined over framework primitives (Arc, Task, Worker, recovery, Action queue) and never over codebase-specific artifacts, so they hold for any Mars deployment regardless of what its agents produce. A single 'harness health' scalar is deliberately rejected: the goals (autonomy, frugality, resilience, operator ergonomics) trade against each other, so health is a vector and a regression in one KPI is only meaningful held against the others. The canonical vector: Cost per completed Arc, Failure rate, Autonomous completion rate, Recovery success rate.

_Avoid_: metric, stat, gauge, harness health score
