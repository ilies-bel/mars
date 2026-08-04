# Foreground session

An interactive Claude Code session driven by the operator, as opposed to a Session (a Worker's headless execution instance). Identified by the CLAUDE_CODE_SESSION_ID env var that Claude Code exports to its subprocesses; captured at the mars CLI boundary as origin_session_id on the tasks and proposals it enqueues, letting deep reflect join the operator conversation with the downstream slice (enqueue, worker runs, merge).
