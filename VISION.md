# VISION.md

> The north star. What Mars is, who does what, and what it must be true of.
> Written from **the consumer's seat** — someone who installed Mars and has no
> source tree. For what exists today, see [`ARCHITECTURE.md`](./ARCHITECTURE.md);
> for the claim and its proofs, [`POSITIONING.md`](./POSITIONING.md); for
> vocabulary, `CONTEXT.md`; for settled trade-offs, `docs/knowledge/decisions/`.
> Supersedes `docs/knowledge/vision.md`, which is deleted, not deprecated.

---

## 1. What Mars is

**An LLM-agnostic dark factory for coding.**

Vibe coding traded your control for speed. Mars gives you the speed and keeps the
control. Agents write most of the code; you are still the engineer at the end of it.

**Dark factory** is meant literally and narrowly: the floor runs with the lights
off *while there is work*. It is demand-driven, not perpetual. When the queue
drains, Mars idles — it does not invent work to stay busy, and it never spends
your subscription on something nobody asked for.

You do not come back to a finished product. You come back to **a queue of
decisions**, and the measure of Mars is how good those questions are — not how
few of them there are.

## 2. Who does what

| | |
|---|---|
| **The operator** | Decides what blocks Mars. Grills proposals — Mars's and their own. Creates new ones. |
| **Mars** | Everything else, including how it runs itself. |

The operator **never authors tasks**; the Slicer does. They supply intent and
judgment, and both are authority, not labour.

**The line: autonomy governs *how Mars runs itself*, never *what gets built*.**
Mars may dial its own configuration, author its own workflows, install its own
gates and start without asking. It may not decide that a proposal is ready, and
it may not absorb a failure it could not fix. Those two reach a human, always.

## 3. Hard requirements

Non-negotiable. Any design that violates one is wrong.

| # | Requirement |
|---|---|
| HR-1 | **The consumer has no source tree.** Mars is a finished product on someone's machine. Everything reflection and growth surface must be actionable by that person, through Mars — never "patch the framework". |
| HR-2 | **The UI is the main surface.** Not a viewer over a terminal-first product. |
| HR-3 | **One API, three callers.** UI, CLI and agents call the same application service. Parity lives at the API, never per-surface. The CLI is secondary — the surface agents and scripts drive. |
| HR-4 | **Full autonomy by default.** Mars acts, then tells. Every autonomous act is **announced as a Notice** and **revertible by construction** — a change that cannot be expressed as a revertible move is not a legal autonomous act. |
| HR-5 | **Autonomy stops at the work.** Proposals are grilled by a human. Exhausted recoveries reach a human. Neither is ever automated away. |
| HR-6 | **No operator-facing message is a machine string, and every one is readable cold.** See §7. |
| HR-7 | **Provider-agnostic.** No provider SDK in the core, no key held by Mars in the default configuration. |
| HR-8 | **Stack-agnostic at the start; opinionated by observation.** Mars knows nothing about your repo on day one and earns its gates as it watches. |
| HR-9 | **Git is concrete.** Not abstracted, not a port. Worktrees are load-bearing. |
| HR-10 | **Idle is a legal state.** No work means nothing running. |
| HR-11 | **Mars never evaluates the operator.** There is no surface on which a failure is the operator's fault, so there is nothing to give them feedback about. |

### Explicit non-goals

- **A read-only UI.** Dead artifact of an earlier design.
- **Teams.** One operator, one repo. Not a limitation to apologise for.
- **A perpetual agent.** Nothing runs at 3am unless there is queued work.
- **Coaching the operator.** See HR-11.
- **A queue-size target.** Suppressing questions is not the same as answering them.

## 4. Decisions

| # | Decision | Consequence |
|---|---|---|
| DEC-1 | **The UI is the main surface; the CLI is secondary.** | Supersedes the read-only-UI non-goal. Both are clients of one API, so a gesture is built once and appears wherever it is rendered. Agents call the same API by request. Parity is not promised per-surface; the API is the contract. |
| DEC-2 | **Mars may change its own configuration and its own workflows, unprompted.** | Supersedes the no-direct-apply rule (ADR-0093) and write-time approval for self-authored workflows (ADR-0068). It does **not** supersede the rule that every finding must bind to something the consumer can change (ADR-0092) — that is the core, not the exception. Autonomy changes *who applies*, never *what may change*. Expressed in existing vocabulary: the default Autonomy level is `tell`, not `ask`. |
| DEC-3 | **Every autonomous change is revertible by construction and announced as a Notice carrying its revert.** | A ledger entry alone is not enough: a change you cannot cheaply undo is `off` with extra steps. Revertibility is a build constraint, not a feature — an act that cannot be reverted is not a legal autonomous act, which makes this testable by attempting one. |
| DEC-4 | **Mars changing its own code is an ordinary task.** | Queue, worktree, verify, merge, and exactly one recovery attempt (ADR-0040 survives intact). The thing that carries real risk — a diff landing on `main` — keeps every control. No carve-out for Mars's own repo. |
| DEC-5 | **Dials and workflow updates are not tasks.** | No queue slot, no worktree, no verify, no commit. The reason is structural: a task editing the implement workflow would run *on the file it is editing*, and a checkpoint-resume engine cannot reconcile a definition that changes underneath it. Taking the edit out of the queue removes the bootstrap hazard at the root. |
| DEC-6 | **Workflow edits apply mid-run.** | Workflows are code, not data; there is no definition to snapshot and pin. The cost is taken knowingly: adding a step downstream is survivable, removing or renaming a step a run has already passed is not, and "did that dial help?" cannot be answered by comparing versions because the before/after is smeared. |
| DEC-7 | **The morning state is a queue of decisions, and the measure is question quality.** | Optimise alert *sharpness*, never alert count. An agent improving Mars under this vision sharpens questions; it does not engineer them away. |
| DEC-8 | **Asking is forbidden while an automated move remains.** | The Alert/Notice line is decided by operator obligation, not severity (ADR-0104). This is the only bound on queue size, and it is constitutional: Mars cannot defer a decision it could have taken. |
| DEC-9 | **There is no explicit bound on queue size.** | Keeping the queue healthy is the engineer's job — maintaining and feeding the system. A volume target would create pressure to suppress rather than resolve. |
| DEC-10 | **Reflection and growth may only ever surface consumer-actionable things.** | The changeable surface: workflows, verify gates, recovery recipes, control levers, provider/worker configuration, pool caps, glossary and ADRs, the project's own vision, and the operator's own repo (tooling, tests, CI). Open-ended — new modules extend the list. Nothing outside it may ever be suggested, because the consumer cannot act on it. |
| DEC-11 | **Mars starts stack-agnostic and earns its gates by observation.** | Onboarding does not need to be clever. No linter? Mars notices and adds one. The gate set starts near-empty and accumulates, each gate traceable to the observation that justified it. This resolves the tension between "value fast" and "detect the stack correctly" by refusing both horns: detection is shallow, and growth fills it in. |
| DEC-12 | **Borrowing a coding CLI is one adapter kind, not the architecture.** | The provider port admits subscription-backed harnesses (Codex through an existing `codex login`) *and* key-backed adapters, because some vendors' terms forbid the first. Consequence stated plainly: "no API keys, no per-token bill" is a property of **one configuration**, not of Mars. |
| DEC-13 | **Git stays concrete; the execution environment is deferred.** | Worktrees are not abstracted behind a port. Whether work can run somewhere other than the operator's machine is an open question (§10), not a commitment. |
| DEC-14 | **Onboarding runs a task and the interview in parallel.** | The factory starts working while the vision conversation happens, so the interview's dead time becomes the proof. If the first task fails, it fails while the operator is mid-conversation with Mars — which is exactly when a failure is cheapest to explain. |
| DEC-15 | **The first commit is the gate Mars is missing.** | Growth's first turn, on minute one. Universally applicable, because every repo is missing some gate; and load-bearing rather than a demo, because every later task is verified by it. First impression and first infrastructure are the same act. |
| DEC-16 | **The factory just starts. No veto, no confirmation.** | Full autonomy applies from the first minute. It is on a branch, it is verified, it is revertible, and it told you — which is the whole answer to "a stranger's tool is writing to my repo". |
| DEC-17 | **It idles.** | An empty queue means nothing runs. No self-generated 3am work, no background self-improvement loop. Growth reacts to observed events and produces proposals that wait; it is never a job that invents work to justify running. |
| DEC-18 | **Everything Mars says to the operator is written for a cold reader; Mars's internals are left as they are.** | Prompts, failure signatures and machine strings keep their density — they are engineering surfaces. The rule in §7 binds only what an operator reads. This also settles the apparent conflict with visual-first UI: minimise the raw material, make what survives excellent, and internals become evidence behind a disclosure rather than the thing read first. |
| DEC-19 | **A suggestion is dismissed with one of two verbs the operator picks: *later* or *stop asking me that*.** | Mars never infers which was meant — guessing wrong in the expensive direction turns every suggestion into noise. *Stop asking me that* kills **that one suggestion**, not its class and not a topic; a sibling suggestion may still come. No reason is required. |
| DEC-20 | **Mars never gives the operator feedback about their approach.** | The operator does not author tasks (the Slicer does) and does not own the baseline (the framework repairs it). With no surface on which a failure is theirs, feedback would only ever be disagreement with its owner. |
| DEC-21 | **"The framework and the user grow together" survives as: Mars explains itself.** | When Mars dials something, quarantines a gate or picks a recovery, it says why. Growth is one-directional in code and two-directional in understanding. Transparency, never evaluation. |

## 5. Swappability

Every capability is a **module behind a port** — a service slot bound to an
interface whose arguments and results are plain serializable data. Callers
resolve ports through the container, never by importing an implementation.

This is not a separate feature from DEC-10; it is the same rule seen from the
other side. **The consumer's surface of changeable things is the set of
installed modules**, and it grows by installing more rather than by patching
Mars. That is why the source tree never has to be reachable.

The one thing pluggability was designed never to touch is the write funnel:
whatever a module changes about *what runs* or *how it is classified*, it can
never change *whether the work is recorded*. Everything is swappable except the
guarantee that the record is kept.

## 6. Notices, alerts, suggestions

Three things reach the operator, and they are distinguished by what they ask.

- **Notice** — informs, asks nothing, because Mars still has a move and is
  taking it. Cleared by acknowledgment. Every autonomous act produces one, and
  carries its revert.
- **Alert** — needs a decision, because the last automated move is spent. Shown
  while the condition holds; ends when it ceases.
- **Suggestion** — an offer Mars is not entitled to take. Dismissable with
  *later* or *stop asking me that* (DEC-19).

What can legitimately block Mars, and therefore what an Alert is ever about:

| Blocker | Why a human |
|---|---|
| A proposal awaiting grilling | Shaping work is authority, not labour |
| Exhausted recovery | The one automated attempt is spent |
| Ambiguous intent | Two valid builds; the choice is a product decision |
| A contested fact | The work contradicts a glossary term or ADR already settled |
| An irreversible act | Outside the revertible envelope — deletion, credentials, money, reaching outside the repo |
| Taste | Visual and UX work, which is why live tasks exist |

## 7. The legibility rule

> **No operator-facing message is a machine string.** Every one names the
> situation in plain language and, if it is an Alert, the decision it wants. The
> signature, the stack trace and the command output remain available as
> evidence — behind a disclosure, never as the headline.
>
> **Every message is readable cold.** The reader has no context: they were
> asleep, they were in another repo, it is Monday. A message that only makes
> sense if you watched it happen has failed.

The second sentence is the one that does real work in a dark factory, and it is
mechanically checkable: take any message Mars produces, strip the session around
it, and ask whether it still says what happened and what is wanted.

## 8. How to falsify this

Each claim below is paired with the observation that disproves it. An agent
improving Mars runs these against a **live installation through the UI**, because
the UI is the operator surface (HR-2) and a claim tested through the CLI has not
been tested where it is made.

| Claim | Falsified by |
|---|---|
| HR-4 / DEC-3 — every autonomous act is revertible | Provoke an autodial, then look for its revert. A Notice with no revert, or a revert that fails, falsifies it. |
| HR-4 — Mars acts, then tells | An autonomous change with no Notice on the operator surface. |
| HR-6 / §7 — messages are readable cold | Open any Alert with no prior context. A signature, a stack trace or a bare path as the headline falsifies it. |
| HR-5 / DEC-8 — Mars never asks when it could act | An Alert raised while an automated move remained. |
| HR-11 / DEC-20 — Mars never evaluates the operator | Any message attributing an outcome to the operator's method. |
| DEC-10 — suggestions are consumer-actionable | A suggestion the operator cannot act on without a source tree. |
| DEC-11 — gates are earned by observation | Run against a repo with no linter, generate lint-shaped failures, and check a lint gate appears. |
| DEC-15 / DEC-16 — the factory starts unasked with a gate | Install into a fresh repo and wait. No dispatch, or a first commit that is not a gate, falsifies it. |
| DEC-17 — it idles | Drain the queue and watch for spend. |
| DEC-19 — dismissal is respected | Dismiss with *stop asking me that*; the same suggestion returning falsifies it. |
| DEC-21 — Mars explains itself | An autonomous act whose Notice states what changed but not why. |
| HR-2 — the UI is the main surface | Take any act Mars offers and try to complete it in the UI alone. An affordance whose only completion is a CLI command, or a slash command in another tool, falsifies it. |
| DEC-2 — Mars changes its own config and workflows unprompted | Provoke a condition Mars has a configured response to, then watch without touching anything. A change Mars only ever proposes, or that waits on an operator gesture to apply, falsifies it. |
| HR-7 — provider-agnostic | Install with the default configuration and dispatch a task. A provider SDK imported by the core, or an API key Mars must hold for that default path to work, falsifies it. |
| DEC-6 — workflow edits apply mid-run | Edit a workflow while a run is in flight, then watch that run reach a step after the edit. A run that finishes on the definition it started with, or that pins a snapshot taken at dispatch, falsifies it. |

## 9. Definition of done

One run, against a repo Mars has never seen, judged on five beats in order of
how much they convince:

| Beat | Why it lands |
|---|---|
| The factory starts before you finish talking to it | Proves onboarding is parallel, not a wizard |
| The first commit is a gate, and it verifies the next task | Proves growth is real infrastructure, not a demo |
| A failure arrives as an alert you can read cold | Proves the product respects the operator's attention |
| A suggestion is offered, dismissed, and stays dismissed | Proves it is a colleague, not a nag |
| It dials something, tells you, and you undo it in one move | Proves autonomy is safe rather than merely fast |

Explicitly **not** required: a finished feature, an empty queue, or a night
without a single question.

## 10. Open

Deliberately unresolved. Each is designed around rather than waited on.

- **Execution environment.** Whether work may run somewhere other than the
  operator's machine. Deferred, not decided. The "one operator, one machine"
  framing holds until it is.
- **The seal.** The write funnel (§5) is stated as surviving, but nothing in
  this conversation reaffirmed it explicitly. If everything is swappable, this
  is the one exception and it should be decided on purpose.
- **Notice placement.** Which operator surface Notices land on has changed
  three times in the ADR record. The vision does not settle it.
- **Autodial specifics.** What may move, on what signal, and whether the
  operator can pin a value against it.
- **Whether POSITIONING.md folds into this document** or stays a derivation.

## 11. Amending this document

**What is written here stays as it is. It may be completed, never revised.**

An agent working from this vision may **append** — a decision that was taken and
never written down, an open question that got settled, a falsification test for a
claim that has none. It may not rewrite an existing decision, soften a hard
requirement, or delete a line because the code disagrees.

When reality contradicts something written here, the code is wrong until the
operator says otherwise. The agent files a **proposal** saying so and leaves the
text alone.

## 12. What this supersedes

- `docs/knowledge/vision.md` — deleted. Its non-goals "no write surface in the
  UI" and "no cloud" are both retired: the first by DEC-1, the second reduced to
  an open question (§10).
- ADR-0093 (findings always enqueue, no apply path) — by DEC-2.
- ADR-0068 (self-authored workflows approval-gated at write time) — by DEC-2.
- ADR-0057 (scaffolded workflows are user-owned) — narrowed by DEC-2: the file
  is still never overwritten by an *update*, but Mars itself may edit it.
- ADR-0092 (findings bind to a user-updatable lever) — **not** superseded.
  Reaffirmed as the core of DEC-10.
- ADR-0040 (one recovery attempt) — **not** superseded. Reaffirmed by DEC-4.
- ADR-0104 (Alert/Notice decided by obligation) — **not** superseded.
  Reaffirmed by DEC-8, and load-bearing for DEC-9.
