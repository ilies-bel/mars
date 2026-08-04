# The main thread is a first-class conversation; every unprompted Mars action speaks there carrying its own autonomy lever

The glossary defined the main thread as "Subject boundary" — a state (no Subject
active), not an entity — so three successive specs decorated that state (sidebar
rank, alert surfacing, a ranked greeting) while `chatConversationEntrySchema`
still required `threadId` + `subthreadId`, leaving no representable message that
belongs to the main thread itself; the composer there forks a Subject on first
send, so Mars has never had a place to speak.

Decision: the main thread becomes a first-class conversation that owns messages
of its own — zero-token, system-authored Notices, streamed with simulated typing
so they read as speech rather than as a log, rendered as cards whose Preloaded
responses do two things: open a dedicated grilling Subject, and write the
Autonomy level (off/ask/tell) of the exact lever that produced the message. That
makes "stop doing this automatically" and "don't ask again" one mechanism rather
than per-card special cases, and it means every unprompted Mars behaviour is
silenceable at its origin from the message announcing it. A Notice may also be
spoken into an Active subject without taking the floor, and a closing Subject
folds its outcome back into the main thread as a Context line.

Trade-off: this re-admits system-authored rows into the chat store that ADR-0080
removed to stop durable-thread churn. Accepted because the bound is different in
kind — volume is now limited by the autonomy levers themselves, which the
operator controls from the message, rather than by a projection rule that no
operator could tune. ADR-0085's "Alerts stay in the Bell, never auto-converted"
is upheld: the main thread speaks Notices, not Alerts.
