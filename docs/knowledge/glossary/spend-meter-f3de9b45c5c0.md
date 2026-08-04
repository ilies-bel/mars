# Spend meter

An observe-and-warn subsystem that sums cache-weighted token usage over a rolling wall-clock window and per-arc, raising a level-triggered action-queue row when a configured token threshold is crossed; it never pauses dispatch or suppresses recoveries.

_Avoid_: spend governor, budget guard, cost cap, token governor, metric, gauge
