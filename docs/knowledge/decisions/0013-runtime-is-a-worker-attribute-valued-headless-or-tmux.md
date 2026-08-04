# Runtime is a Worker attribute valued headless or tmux

Context: every Worker today is the same shape — a headless `claude -p` invocation whose output the operator can only inspect after the fact. There is nowhere in the model to express "this kind of Task wants a different execution style" (e.g. an attachable pane the operator can watch and coach mid-run).

Decision: introduce a `Runtime` field on the Worker, valued `headless` or `tmux`. `headless` is the default and preserves today's behaviour. `tmux` runs the Session as a window inside a single per-repo tmux session the operator can attach to. Tasks reach a tmux-Runtime Worker by carrying tags that match the Worker's tag set; a Task with no tags (or no match) falls back to the default headless Worker, so existing behaviour is unchanged.

Why Runtime is a Worker attribute (not per-Task): operators choose execution shape by configuring Workers, not per dispatch. Per-invocation Runtime override flags are explicitly out of scope — a Task picks its Worker via tags, and the Worker dictates Runtime. This keeps Task prompts portable and avoids a second routing surface.

Alternatives considered:
- Per-Task `runtime:` field on the queue row, picked at enqueue time. Rejected: gives every caller a knob that should live in operator configuration, and forks the dispatch logic.
- Replace the existing dispatcher with a supervisor agent that watches Sessions and intervenes. Deferred to v2 — without tmux the supervisor has nothing to attach to, and shipping the attach surface first lets the operator be the supervisor while we learn what an automated one would need to do.
- Use an alternative multiplexer (zellij, screen, dtach). Rejected for v1: tmux has the broadest install footprint, the most stable scripting surface (`tmux send-keys`, `capture-pane`), and is what the inspiring prior art (multiclaude) uses. A second backend can be added later behind the same Runtime field if there is demand.
- Per-Worker process-reuse / cross-Session memory so a tmux Worker keeps state between Tasks. Rejected: Runtime is about execution shape, not state persistence. Each Session still starts fresh; the pane is the only thing reused.

v1 scope boundary — explicitly out of scope:
- A supervisor agent that auto-nudges stuck Sessions.
- Per-invocation Runtime override flags on `mars task add`.
- Cross-Session memory or context reuse between Tasks running on the same Worker.
- Alternative multiplexers (zellij, screen, etc.) — tmux is the only non-default backend in v1.
- Changes to verify, merge, or the Fix-task recovery loop. This work lives on an exploratory branch and does not touch the surface area where current Blockers live.

Deferred decisions, resolved for v1:
- **Tags are free-form in v1.** A Worker's tag set and a Task's tag set are arbitrary string lists; routing is exact-match. A controlled vocabulary can be layered on later once we see what operators actually type.
- **The per-repo tmux session is created lazily.** No tmux process is spawned at daemon start; the first tmux-Runtime dispatch creates the session, and subsequent dispatches reuse it. Daemons without tmux installed pay no cost until a tmux-Runtime Worker is configured.

Completion model is unchanged: a tmux-Runtime Session is "done" when the `claude` process inside its pane exits cleanly, exactly like a headless Session. Verify and merge run identically afterwards.
