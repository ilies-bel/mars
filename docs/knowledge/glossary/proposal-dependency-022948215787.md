# Proposal dependency

A row in proposal_dependencies asserting that one Proposal cannot be meaningfully PRD-shaped until another Proposal reaches sliced; lives in the planning graph, is written by operators or by the recursive planner when it spawns a gap-filling child Proposal, and is never fanned out into task_blockers when the blocker Proposal is sliced.

_Avoid_: proposal blocker
