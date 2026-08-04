# KPI drift

A sustained move in a KPI against its own rolling baseline (this window vs. prior) — the signal the dashboard exists to surface. Detecting drift requires a persisted KPI time-series; today KPIs are recomputed and printed, never stored, so drift is invisible. Drift in one KPI is read against the rest of the vector, never alone (see KPI).

_Avoid_: regression, metric drift, trend
