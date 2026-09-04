# Chat Surface Boundary — Decision Brief

**Date:** 2026-09-04  
**Status:** Proposed — for operator review  
**Scope:** Investigation only. No product code was written.

---

## Context: Three reversals, one boundary

The boundary between "chat" and "the action queue" has flipped three times in
four ADRs:

| ADR | Decision |
|-----|----------|
| 0075 | Chat absorbs the action queue; every alert becomes a Thread |
| 0080 | Reversed: Bell gets alerts+notices, chat gets threads only |
| 0085 | Reversed again: Notices re-enter the chat feed |
| 0089 | Main thread becomes a first-class entity; Notices spoken there |

Each reversal was a reaction to a real problem. None of them was wrong at the
time. The instability is not sloppy thinking — it is evidence that two
genuinely distinct user intents are being resolved through one naming decision.
This brief names those intents, takes a position on the boundary, and proposes
an ADR that settles it.

---

## Q1: What distinct user intents does "chat" serve today?

Three distinct intents share the name "chat". Each is served by a different
system:

### Intent A — Ask Mars a question / direct an action (conversational)

The user wants to converse with Mars: ask what is happening, direct it to
enqueue a task, inquire about a failing arc, run a shell command. This is a
*stateful, turn-based interaction*. It expects a reply in the same context as
prior turns.

**System serving it:** The **UI chat agent** — `chat_threads` /
`chat_messages` in the database, served via `chat-runner.ts`, driven by the
Codex Responses API directly (ADR-0082). Each thread is a Codex session whose
transcript the daemon owns and replays. The main thread (`MAIN_THREAD_ID =
'main'`) is the persistent entry point; Subjects are focused forks.

### Intent B — Get oriented / triage (dispatch)

The user types `/mars:chat` in a Claude Code terminal session. They want to
know what demands their attention and be dispatched to the right resolver. This
is *stateless and one-shot*: it does not hold a conversation, has no memory of
prior invocations, and does not reply to follow-up.

**System serving it:** The **`/mars:chat` Claude Code skill**
(`orchestrator/src/init/templates/claude/skills/chat/SKILL.md`). Its own
description calls it a "triage router." It classifies input and delegates to
`/mars:action-queue`, `/mars:task`, `/mars:grill`, `/mars:unblock`, or
`/mars:live`. If a user's mental model of "chat" is "talk to Mars," this skill
is the opposite of that.

### Intent C — Stay informed of system events (notification)

The user wants to see what Mars did unprompted: a task failed, the steward
quarantined a gate, a merge landed. These are *system-authored, zero-token
messages* that require no reply. Replies would be nonsensical.

**System serving it:** **Notices in the main thread** (ADR-0085, ADR-0089) —
`kind='notice'` messages written to the `main` thread by the daemon.
Alert-derived rows (`failed`, `stale-queued`, etc.) are computed on read from
live state (ADR-0094) and surface in the Bell, not in chat.

---

## Q2: Are chat and the action queue one surface or two?

**Recommendation: two surfaces, with a narrow, one-way bridge.**

### What ADR-0075 got right

ADR-0075 correctly identified that the operator has one inbox. Every item
demanding attention should be discoverable from one place, not split across
tabs. The "merge the surfaces" intuition was sound.

### What made it reverse (ADR-0080)

The implementation broke the projection rule (ADR-0048/0054): every
`raiseActionQueueItem` call fire-and-forgot a `chat_threads` row. Alerts are
*derived from live state*; storing them as durable rows means they can go
stale, pile up, and overwhelm the conversation list. ADR-0080 correctly
diagnosed that durable-thread churn from condition-kind alerts was the
pathology, not the merge itself.

### What ADR-0085 got right — and what the partial reversal costs

ADR-0085 re-admitted *Notices* (not Alerts) into the chat feed, because
ADR-0077 required all Steward/Reflector output to reach the human through the
unified first-person chat. That constraint is correct. Notices are
operator-authored in spirit (each Notice exists because an autonomy lever
fired), bounded in volume, and carry actionable Preloaded responses. They
belong in the chat feed.

The cost: "chat shows only threads" (ADR-0080's clean rule) is now partial.
The rule is "Alerts stay in the Bell; Notices go in chat." That is a
distinction the UI and any new code must remember.

### The correct model

The action queue is a **priority-ordered list of items that demand an operator
decision**. It is composed entirely of derived-condition kinds and
row-backed-operator-decision kinds (ADR-0094). It is not a conversation
surface; it is a work queue with a UI projection.

The chat surface is a **continuous, operator-readable conversation with Mars**,
anchored in the main thread. Subjects fork off that thread for focused work.
Notices are system-authored turns in that conversation.

The bridge: an item in the action queue can be *pulled into* a Subject (the
user opens a thread from a Bell Alert — ADR-0080's "a human pulls one into a
thread" path). That pull is one-directional and explicit; alerts never
auto-convert.

**ADR-0075's merge was wrong in mechanism (durable alert rows), right in
intent (one inbox). ADR-0080 fixed the mechanism, kept the Bell as a
lightweight projection. ADR-0085 correctly narrowed to Notices only. The model
is now settled; it just needs to be named clearly.**

---

## Q3: Should `/mars:chat` become stateful?

**No. Rename it. The current behaviour is correct; the name is the bug.**

The `/mars:chat` skill is a triage router. Its routing logic is sound: it
classifies input, dispatches to the right resolver, and exits. Making it
stateful would conflate two intents that are deliberately separate:

- The **UI chat** (Intent A) is stateful because it needs context — the
  operator is in a conversation with Mars.
- The **Claude Code skill** (Intent B) is stateless because its job is
  orientation, not conversation. A stateful router would accumulate context
  across invocations with no place to put it.

**Proposed rename:** `/mars:chat` → `/mars:dispatch`

`dispatch` is what the skill actually does. It removes the false equivalence
with the conversational UI. The old name remains valid as an alias via the
skill's `description` field for a transition period, but the canonical name
should change.

The skill's SKILL.md already says "You are the Mars **triage router**." The
name should say that too.

---

## Q4: Does the fork/subthread model earn its complexity?

**Partially. The schema complexity is real; the query-time complexity is where
the cost is paid.**

### What the model provides

Subjects (`chat_threads` rows with a non-`main` id) give each focused
conversation:
- An independent `closed_at` lifecycle.
- A `terminal_event_type` / `terminal_entity_id` for auto-close (ADR-0084).
- An `objective` and `terminal_condition` enforced at creation
  (`openSubject.ts`).
- Breadcrumb compression: `listClosedSubjectBreadcrumbs` collapses a closed
  Subject to a compact card, avoiding context-window bloat.

### What the Vicoa flat-message model would offer instead

A flat message table with typed metadata could express subject boundaries as
metadata on ordinary rows, grouping them client-side. This avoids the FK
complexity and the interleave problem in `listConversationEntries`. The read
cursor would live on the session, not per-thread.

### The actual cost of the current model

The real complexity is not the schema — it is `listConversationEntries()`. That
function does a global sequence scan across every thread where
`closed_at IS NULL OR t.id='main' OR m.kind='context_line'`. The `closed_at`
predicate was retrofitted (commit `9829a05f9`) to exclude closed subthreads.
The result is a feed that requires the caller to understand:

1. Why closed-subthread messages are excluded.
2. Why the main thread is always included.
3. Why `kind='context_line'` is always included regardless of `closed_at`.

This is query logic encoding presentation decisions. The three-exception
predicate will grow as new kinds are added.

### Recommendation

**Keep the Subject FK model; fix the query predicate.**

The FK model earns its keep for auto-close, lifecycle, and breadcrumb
compression — these are hard to express cleanly with typed metadata on a flat
table without recreating foreign-key semantics in application code. The Vicoa
comparison is instructive but the Subjects here are a different beast: they
have declared terminal conditions, not just grouping.

The query predicate in `listConversationEntries` should be replaced by an
explicit `context_scope = 'main'` filter on messages, with Notices and
`context_line` messages always written to the main thread (which they already
are). Closed Subject messages would then disappear from the feed automatically,
with no exceptions required. The current three-exception predicate is the bug,
not the threading model.

`parent_thread_id` and `fork_idempotency_key` are present in the schema but
never written except as `null` in all active code paths (`openSubject.ts` sets
both to `null`; the unique index on these columns is therefore dead weight
today). If nested threading is not planned in the near term, these columns
should be removed to prevent the schema from implying a capability that does
not exist.

**Migration for `parent_thread_id` / `fork_idempotency_key` removal:**
Both columns are always `null` in production data (confirmed: `openSubject.ts`
is the only Subject-creation path and it sets both to `null`). Removing them
requires:
1. Drop the unique index `uq_chat_threads_fork_idem`.
2. `ALTER TABLE chat_threads DROP COLUMN parent_thread_id, DROP COLUMN fork_idempotency_key`.
3. Remove the fields from `ChatThread`, `ChatThreadApiView`, and any test
   fixtures that reference them.

What breaks: any planned nested-thread feature. Decision: if nested threading
is not on the roadmap for the next three months, remove now. Columns grow into
implied contracts.

---

## Q5: Does Mars need a read cursor?

**Not yet. The question is premature for a single-operator system.**

### Current state

Neither `chat_threads` nor `chat_messages` has any read-cursor or per-user
read-state column. The `chat_memory_windows` table (`chat-memory-window.ts`)
tracks a `starts_after_seq` for the main thread's reusable prefix — this is
a *context-window boundary* for the AI model, not a human "have I seen this?"
cursor.

### The Vicoa warning

The Vicoa reference design documents a severe bug from conflating the
reply-waiter cursor with the content-publisher cursor: last-writer-wins made
the waiter's cursor stale and silently denied a question the user was about to
answer. The lesson: **a "waiting for a reply" mechanism must never share a
mutating watermark with a "publishing new content" mechanism.**

Mars does not currently have a reply-waiter. The chat runner does not poll a
cursor to decide when to speak next — it responds to an HTTP POST per turn.
The Vicoa bug requires two concurrent writers to the same cursor; Mars has one
human operator and one daemon.

### When a read cursor becomes necessary

A read cursor makes sense when:
1. Multiple consumers read the same feed (multiple human operators, a
   notification client, a mobile app).
2. "Unread" state needs to be communicated across sessions or devices.

Mars has one operator today. The `chat_memory_windows.starts_after_seq` cursor
correctly tracks where the AI's context window begins; that is separate from
human read-state.

**Recommendation:** Do not add a read cursor now. Log this as a known gap. If
multi-operator or multi-device access is added, the cursor belongs on the
**session**, keyed by `(session_id, thread_id)`, not on the message rows. That
is consistent with the Vicoa lesson: the cursor is a session property, not a
message property.

---

## Independent bugs — enumerable regardless of boundary decision

These are correctness defects fixable without resolving the boundary question:

### Bug 1: `listConversationEntries` predicate is fragile

**File:** `orchestrator/src/core/lib/chat-store.ts:843`  
**Problem:** The WHERE clause `(t.closed_at IS NULL OR t.id = 'main' OR m.kind = 'context_line')` encodes three separate presentation decisions as SQL exceptions. New message kinds that should survive a Subject's closure must be added here manually; there is no structural guarantee.  
**Fix:** All messages that should persist across Subject closures should be written to the main thread with `context_scope = 'main'`. The predicate becomes `t.id = 'main' OR t.closed_at IS NULL`. Notices and `context_line` messages already target the main thread — the exception clause for them is vestigial.

### Bug 2: `parent_thread_id` / `fork_idempotency_key` are dead columns

**File:** `orchestrator/src/core/lib/pg-schema.ts:1124-1128`  
`orchestrator/src/core/subject/openSubject.ts:92-93`  
**Problem:** The columns are present in the schema and their unique index is created, but `openSubject` (the only Subject-creation path) always writes `null` for both. The unique index is therefore never used and always traversed. The columns imply a nested-threading capability that does not exist.  
**Fix:** Drop the columns and the index in a DDL migration. Remove from `ChatThread`, `ChatThreadApiView`, and test fixtures.

### Bug 3: `context_scope` migration is load-bearing boilerplate

**File:** `orchestrator/src/core/lib/pg-schema.ts:1158-1203`  
**Problem:** The `context_scope` `CHECK` constraint migration (renaming `'subject'` → `'subthread'`) runs on every daemon boot inside a transaction. If a future schema change adds a new constraint touching `context_scope`, it must understand this block or boot will loop. The migration itself is correct, but its replay-on-every-boot nature means the context-scope constraint is permanently conditional on this PL/pgSQL block.  
**Fix:** Once the migration has run on all known databases, replace the DO block with a simple `ALTER TABLE chat_messages ADD CONSTRAINT IF NOT EXISTS …` so the boot sequence is less fragile. This is a maintenance-window change, not urgent.

---

## Proposed ADR

> **Draft — not yet filed. The operator decides whether to run `mars adr add`.**

---

### ADR-0105: Chat is the conversation; the action queue is the work surface; `/mars:chat` is renamed `/mars:dispatch`

**Status:** Proposed

**Context:**  
Three successive ADRs (0075, 0080, 0085) have redrawn the boundary between
the conversational chat surface and the action queue. Each reversal was a
response to a real problem. The instability indicates that two user intents
have been conflated under one name. The name "chat" covers: (a) a conversational
UI backed by persisted threads and a Codex session; (b) a stateless Claude Code
triage skill that classifies input and dispatches to sub-skills; and (c) a
notification channel for system-authored Notices.

**Decision:**  
Three surfaces, named by intent:

1. **The UI chat** (`chat_threads` / `chat_messages`, served by `chat-runner.ts`)
   is the **conversation surface** — a persistent, turn-based dialogue between
   the operator and Mars. The main thread is the always-open entry point. Subjects
   fork off it for focused, declared-purpose conversations. Notices (system-authored,
   zero-token, kind=`notice`) are spoken into the main thread. Alerts remain in
   the Bell (derived on read, never stored as chat rows). This naming and boundary
   is unchanged from ADR-0085 + ADR-0089.

2. **The action queue** (derived condition kinds + row-backed operator-decision
   kinds, per ADR-0094) is the **work surface** — a priority-ordered list of
   items demanding an operator decision. It is not a conversation surface. An
   alert can be *pulled into* a Subject by explicit operator gesture; it never
   auto-converts (ADR-0080's core rule, preserved).

3. **The Claude Code skill** currently named `/mars:chat` is renamed
   `/mars:dispatch`. Its behaviour is unchanged: it classifies input and
   dispatches to the appropriate sub-skill. The old name is retained as a synonym
   in the description for one release cycle. The reason for the rename: "chat"
   implies conversational state that this skill deliberately does not have. The
   skill's own SKILL.md already describes it as a "triage router"; the name
   should match.

**Consequences:**
- `/mars:dispatch` replaces `/mars:chat` as the canonical name. The `chat`
  alias remains in the skill description for one release.
- No schema change. No chat-runner change. No action-queue change.
- The Skill file at `orchestrator/src/init/templates/claude/skills/chat/SKILL.md`
  is moved to `.../skills/dispatch/SKILL.md`. Consumer installs pick up the
  rename on the next `mars update`.
- All three of ADR-0075, ADR-0080, ADR-0085 described the correct system for
  their moment. This ADR is the settlement, not a reversal: it names the three
  surfaces that those three ADRs collectively converged on, and closes the
  naming ambiguity that made them read as contradictions.

**Trade-offs accepted:**
- `/mars:dispatch` is a less familiar entry point for new users than `/mars:chat`.
  Mitigated by keeping `chat` as a synonym and updating the `CLAUDE.md` description.
- The three-surface model requires new code to know which surface a message or
  event belongs to. The rule is simple: Alerts → Bell (derived); Notices →
  main thread (system-authored); user turns → whichever Subject is active.

**Rejected:**
- Merging the action queue back into chat (ADR-0075's path): durable alert rows
  cause churn and stale state, as observed before ADR-0080.
- Making `/mars:dispatch` stateful: it has no session to bind to in a Claude
  Code context, and its job — orientation and dispatch — does not benefit from
  memory of prior invocations.

---

## Recommendation summary

| Question | Recommendation |
|---|---|
| Q1: User intents | Three: conversation (UI chat), orientation (dispatch skill), notification (Notices) |
| Q2: One surface or two? | Two: conversation and work queue. One-way bridge via "pull into Subject" |
| Q3: Stateful skill? | No. Rename `/mars:chat` → `/mars:dispatch`. Behaviour unchanged. |
| Q4: Fork/subthread complexity? | Keep; fix `listConversationEntries` predicate; drop dead `parent_thread_id` / `fork_idempotency_key` columns |
| Q5: Read cursor? | Not yet. Add per-session if multi-operator access arrives. |

The one highest-value action that requires no ADR: fix the `listConversationEntries`
predicate (Bug 1 above). It is a correctness improvement that makes the data
model self-explaining and removes a class of future mistakes.
