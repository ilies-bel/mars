# Non-FF merge

A task arc whose merge step could not land as an instant git fast-forward into the integration branch and therefore had to be reconciled by the vcs-supervisor (Vega), typically because the integration branch advanced after the worktree branched off.

_Avoid_: non-fast-forward, conflicted merge, vega merge
