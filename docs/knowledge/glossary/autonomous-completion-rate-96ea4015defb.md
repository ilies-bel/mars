# Autonomous completion rate

The autonomy KPI: the fraction of Arcs over the window that reached done while raising zero Action queue items — i.e. completed with no human intervention beyond the planning phase. Directly measures the project's headline goal (no human touch except planning). Trades against Cost per completed Arc and Recovery success rate: pushing autonomy up (never ask the operator) tends to cost more tokens and risks a wrong unsupervised choice compounding, which is why it is read as a vector member, not maximised alone.

_Avoid_: autonomy rate, hands-off rate, no-touch rate
