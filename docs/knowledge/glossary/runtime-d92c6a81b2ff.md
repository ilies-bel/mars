# Runtime

A Worker attribute, valued either 'headless' (the agent's print/non-interactive mode, e.g. 'claude -p', the default) or 'pty' (the agent's native interactive harness driven under a non-attachable node-pty, captured to traces/logs — no human attach), that says how that Worker's Sessions execute. Orthogonal to Provider. Set on the Worker, not per Task: Tasks route to a Worker via tag matching and inherit its Runtime.

_Avoid_: tmux, attachable runtime, interactive runtime
