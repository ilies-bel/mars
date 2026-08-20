# Mars — positioning

> The source document. The README, the launch post, the landing page and the
> social copy are all generated from this. If a claim isn't here with a proof
> next to it, it doesn't go in any of them.

---

## The claim

**Mars is Cursor for engineers.**

Vibe coding traded your control for speed. Mars gives you the speed and keeps
the control.

---

## The problem

Vibe coding works. That's the trap.

You ship fast for three weeks and then you're maintaining a codebase you did
not author. You approved diffs you skimmed. There's no record of why anything
is the way it is. Your architecture drifted because nothing was defending it.
The same concept has three names in four files, because every session started
from zero and invented its own vocabulary.

The failure mode isn't bad code. Modern agents write fine code. The failure
mode is **lost authority** — you stopped being the engineer and became the
approve button.

The tools built for this made it worse by design. They optimise for *accepting
suggestions faster*. Every one of them puts a diff in front of you and asks you
to say yes.

Mars asks a different question: what would it take to let agents write most of
your code and still be the engineer at the end of it?

---

## The five pillars

Each pillar below has a proof. Never ship the claim without the proof.

### 1. Control — the pillar that matters

Agents still write the code. Every unit of work passes an engineer's controls
on the way in and on the way out.

| Control | Mechanism | Proof |
|---|---|---|
| A spec before code | `--files` / `--verify` / `--done` produce a typed spec; the implementor receives it as a checklist. The grill shapes fuzzy work into a PRD before a line is written. | `mars task add --help` |
| A gate, not a vibe | typecheck → test → lint, fail-fast. **Green merges. Nothing else does.** | `tools/verify/` |
| A defended vocabulary | The glossary is editable only through `mars glossary` and is read by every Worker. Your terms, enforced across every session. | `CONTEXT.md`, `mars glossary` |
| Defended decisions | ADRs. The trade-offs you already settled don't get re-litigated by an agent at 2am. | `docs/knowledge/decisions/` — 94 of them |
| A record that survives | Every arc in local Postgres. "Why is this line here" has an answer six months later. | `psql "$(cat .mars/pg.dsn)"` |
| Your branch is never raced | Merges serialize behind a file lock and fast-forward. A merge that finds a dirty tree it can't attribute commits it to a checkpoint ref rather than cleaning it. | `tools/merge/`, `core/lib/git/checkpoint.ts` |
| Decisions, not diffs | The action queue surfaces what a machine genuinely cannot decide. You are not a rubber stamp on a diff queue. | `mars action-queue list` |
| Bounded flailing | Exactly one recovery attempt per failure. Then it stops and asks you. No retry budget, no tunable knob, no agent looping until your quota dies. | ADR-0040 |

**The line:** *Cursor asks you to approve a diff. Mars asks you to approve a
decision — and only when there is genuinely one to make.*

### 2. It grows into your repo

The differentiator. An independent survey of nine open-source orchestrators
named this as the gap the entire category has:

> "OSS orchestrators lack **learning persistence** … No tool here maintains
> reusable, improved agent configurations across sessions automatically."
> — Augment Code, 2026

Mars ships opinionated and then bends toward you:

| Your input | What Mars keeps | Where |
|---|---|---|
| A failure it has never seen | An Investigator writes a recovery recipe, so the second time is automatic | `init/recipes-seed.ts`, `outbox/subscribers/recovery-spawn.ts` |
| Friction that recurs across tasks | A draft proposal for a **new step in your workflow** — e.g. *tasks touching `ui/` keep failing verify on screenshot signals → add a browser-check step* | `growth/step-suggestions.ts`, `growth/heuristics.ts` |
| Terms you sharpened in the grill | A glossary every future Worker reads | `CONTEXT.md` |
| Your Workers' measured performance | Rewritten prompt blocks, in a **revertible ledger** | `core/steward-prompt-optimizer.ts`, `core/steward-ledger.ts` |
| Your habits | A notice — with the off-switch attached to the message | `core/levers/store.ts` |

`growth/step-suggestions.ts:2` calls itself *"the 'grow with the user'
surface."* That's not marketing language retrofitted onto code; the code said
it first.

**The line:** *Ships with opinions. After a month, they're yours.*

**The asset:** day 1 vs. day 100 of `.mars/`. Same tool, 100 tasks apart.

### 3. Event-driven and traced

Not a buzzword here — a transactional outbox and a span per step. Together
they're why the state you're shown is never a lie, and why every line of code
in your repo has a paper trail leading back to the decision that caused it.

#### Event-driven

- **The outbox** (`orchestrator/src/outbox/`): an `events` table, named
  subscribers, and a **cursor that advances only when the handler succeeds.**
  A crash mid-delivery replays; it never silently drops.
- **Sixteen subscribers**, each owning one consequence: `blocker-resolution`
  (a task reaching `done` releases everything waiting on it),
  `recovery-spawn`, `steward-runtime-tune`, `desktop-notify`, `invalidator`,
  `transcript-append`, …  Adding a consequence is a new subscriber, not a new
  branch in a god function.
- **The dispatcher is also the throttle.** It tracks in-flight events per
  worker kind and enforces the ceiling returned by the spend-control decision
  — so backpressure and budget are the same mechanism (`outbox/dispatcher.ts`).
- **Inside a run**, cordis's typed event bus (`ctx.on` / `emit` / `serial` /
  `bail` / `waterfall`), with declaration-merged signatures so every call site
  is typed.
- **Out to the UI**, SSE sends *payload-free typed invalidation pings*. The
  client learns a view changed and re-fetches. It never receives a copy of
  state that could go stale in its hands.
- **And what needs no event at all**: condition rows in the action queue are
  derived on read — the queue is a pure projection of entity state (ADR-0048).
  No stored row, no raiser, no sweep. **A condition that does not hold is
  unrepresentable** — stale alerts cannot accumulate because there is nowhere
  for them to live.

**The line:** *Nothing sweeps. Nothing reconciles. Nothing goes stale.*

#### Traced

Every step is bracketed by a span. Not just the model calls — **the whole
pipeline**.

- `run-worker-with-span.ts` wraps LLM-backed Workers (Coder, Fixer, Planner,
  Slicer, Triager) and records the worker name, the provider session id, token
  usage, and the transcript. `runNonLlmStepWithSpan` wraps the steps that
  aren't models at all — setup, verify, fast-forward merge — with start, end
  and outcome.
- The distinction is an enforced invariant, not a convention: **a Step span is
  a Session iff `worker IS NOT NULL`.** One trace surface, two kinds of span,
  no ambiguity about which is which.
- Four phases per arc: `step_started`, `tool_invoked`, `step_ended`,
  `transcript` — so you can replay not just *what* a Worker concluded but
  *which tools it reached for on the way there.*
- Usage signals and session ids are recorded **even when reflection is
  disabled**. Turning off the expensive part never blinds the cheap part.
- **77 tables.** `merge_jobs` records which sha actually landed.
  `mcp_worker_audit` records which tools each Worker called. `learned_recipes`,
  `scorer_results`, `promotion_ledger`, `diagnoses_root_cause`,
  `arc_rescue_attempts`, `kpi_snapshots` — the history isn't a log file that
  rotates away, it's a queryable database.
- It's **your** database. `psql "$(cat .mars/pg.dsn)"` and ask it anything.
  No vendor, no retention policy, no export request, no dashboard that stops
  at 30 days.

And the seal (pillar 5) is what makes all of it trustworthy: a swapped tool
can change what runs, but the framework-owned shell — not the tool — writes
the record. **You cannot install a plugin that makes Mars stop tracing.**

**The line:** *Every commit traces back to the decision that caused it — and
the database is on your disk.*

This is where pillars 1 and 3 meet. "Give back control over vibe-coded work"
is an empty promise without an audit trail: control you can't verify after the
fact is just trust with extra steps. The trace is what turns the claim into
something you can check.

### 4. Lean on tokens

Most agent tools spend your budget on coordination. Mars is unusual in
metering itself.

- **Coordination is free.** Narration is pure — no clocks, no randomness,
  **no model calls** (ADR-0055). Notices are zero-token by invariant. Mars
  spends tokens on work, never on telling you about work.
- **It routes cheap work to cheap models.** Semantic tiers — flagship /
  balanced / fast — resolved per Worker role. Routine judging runs on the fast
  tier. You don't pay flagship prices for classification.
- **It watches its own spend.** `core/daemon/usage-sampler.ts` →
  `core/daemon/usage-accumulator.ts` → `core/lib/usage-snapshot-store.ts`, and
  `core/lib/notices/token-spend-trend.ts` compares the
  recent window against the one before it and *tells you when spend is rising.*
- **It pauses itself.** Spend control computes per-worker-kind ceilings and
  can pause dispatch outright; a provider rate/spend rejection pauses with
  `reason: quota`. Transitions raise an action-queue notice rather than
  quietly burning down your month.
- **It tells you how to be cheaper.** The `economize` skill — codegraph
  instead of grep+Read loops, file ranges instead of whole files, breadth
  fanned out to subagents — targets **60–90% reduction** on typical sessions.
  And if you have no traversal index installed, Mars notices and says so,
  because it can see how many Workers it sent in blind.
- **Orchestration state stays out of the context window.** The human surface
  is a CLI, not a chat transcript that grows until it forgets the beginning.

**The line:** *The only agent orchestrator that tells you it's getting
expensive.*

### 5. Cordis inside — always on the state of the art

Mars learns your repo continuously (see pillar 2). The models it runs on change
every few weeks. Cordis is what lets both be true at once.

The container **is** [cordis 4](https://www.npmjs.com/package/@deepseek-ai/cordis)
(DeepSeek's) — real `Context`, real `Fiber`, real typed event bus. 688 lines of
hand-rolled container were deleted to adopt it. So swapping what Mars runs on
costs nothing:

- **Providers and workers are open registries** you `register()` into, not
  hard-coded unions. Registration returns a disposer.
  → `core/workers/provider-registry.ts`, `core/workers/worker-registry.ts`,
  `registries/verify-heuristics.ts`
- **Models are addressed by tier** — flagship, balanced, fast — never by name.
  A new model generation is a mapping change, not a migration.
- **There are no provider SDKs.** Nothing a vendor ships can break Mars.
- **Swap from outside the repo.** A coder, a verify heuristic, a merge
  strategy, or one step of a workflow, from a `.mars/workflows/*.js` file. No
  fork. Everything ships wired, so swapping is opt-in, never setup.

*(Honest scope: providers and workers are fully open registries today; the
primitive registry has not yet been extracted from `core/lib/primitive-catalog.ts`.
Don't claim it is.)*

Something better ships next month — you point Mars at it, and everything it has
learned about your repo comes with it.

**Mars learns continuously. Cordis keeps it on the state of the art.**

- **One thing is sealed.** `store` and `traceStore` are installed as cordis
  *accessors*, not services, so `ctx.provide('store', …)` throws — and the
  seal holds even under `ctx.isolate` (ADR-0052).

**The line:** *You can change what runs. You can never change whether it was
recorded.*

That sentence is the whole product in nine words: total freedom over
mechanism, zero freedom over accountability. It is also why pillar 1 is
credible — control isn't a policy you can turn off, it's the one thing the
architecture refuses to make configurable.

---

## The framing constraint: personal

One operator, one machine, one repo. Not a limitation to apologise for — the
thing that makes the rest possible.

No auth, no tenancy, no cloud, no telemetry, no concurrency model for other
humans, no hosted control plane, no account. What happens on the laptop stays
on the laptop. Small enough for one person to hold in their head.

Your laptop. Your subscription. Your Postgres. Your audit trail.

**Never say:** "great for teams too." It isn't, on purpose, and the moment you
say it the whole design starts owing explanations it doesn't have.

---

## Proof points

Use these; they're all verifiable.

| Claim | Number |
|---|---|
| Tasks completed by Mars **in Mars's own repo** | **3,187** |
| Commits since 2026-04-27 | 3,799 |
| ADRs written | 94 |
| Source files / test files | 1,249 / 761 |
| Outbox subscribers | 16 |
| Tables in the local trace/state schema | 77 |
| Time | ~4 months, one person |

**Mars grew into the repo that built it.** That's the dogfooding claim, and no
competitor can fake it.

---

## Messaging hierarchy

**H1** — Cursor for engineers.

**Sub** — An agent team that runs on your laptop, your subscription, and your
terms. Queue the work; merged commits come back. Ships opinionated, then grows
into your repo.

**Elevator (30s)** — Vibe coding gave everyone speed and quietly took their
codebase. Mars runs your existing agent CLI as a fleet of parallel workers —
each task in its own git worktree, verified before it merges, with your
glossary and your ADRs as the rules. Nothing merges unless it's green. Every
step is traced — every tool call, every transcript, every merged sha — into a
Postgres database on your disk that you can query with `psql`. And it learns:
your failures
become recovery recipes, your friction becomes new workflow steps, and it even
rewrites its own Workers' prompts — every change announced, levered, and
revertible.

**The word-of-mouth line** — *"It's Cursor, for people who still want to be
the engineer."*

**The claim that structures the debate** (pick one per piece):
- "You can change what runs. You can never change whether it was recorded."
- "Mars learns continuously. Cordis keeps it on the state of the art."
- "Stale alerts are unrepresentable."
- "Coordination costs zero tokens."
- "Every commit traces back to the decision that caused it."

> **One caution on "Cursor for engineers":** it's instantly legible, which is
> exactly why it works — but it anchors Mars to someone else's product and
> invites the "so it's a Cursor clone?" read. Strongest as the line people
> *repeat* rather than the line you *lead* with: put it in the first paragraph
> and the FAQ, and let the H1 carry Mars's own words. Worth A/B-ing on the
> launch post title.

---

## The competitive lane

**Bernstein** is the nearest architectural neighbour — same planning-to-merge
pipeline, per-task worktrees, verify-then-merge. Its pitch is *determinism*:
no model in the coordination loop, runs replay byte-identically, HMAC audit
chain, air-gap deploy, 40+ adapters.

Do not fight it there. It wins, by design.

|  | Bernstein | Mars |
|---|---|---|
| Optimises for | Reproducibility | Adaptation |
| Ideal end state | Run #500 ≡ run #1 | Run #500 is nothing like run #1 |
| Buyer | A compliance reviewer | One engineer and their repo |

**A tool that replays byte-identically cannot grow into your repo.** That's the
trade; Mars took the other side. Name Bernstein in the README and concede its
strengths — in a crowded category it's the most credible move available.

Everyone else (Claude Squad, Conductor, Vibe Kanban, Emdash, Nimbalyst) is a
*supervision* tool: N panes or N cards, and you still merge. Mars closes the
loop. Don't compare feature lists with them; compare what you're doing while
it runs.

---

## What not to say

- ~~"Run agents in parallel in git worktrees"~~ — table stakes; five projects
  say it. It's the mechanism, not the reason.
- ~~"AI-powered"~~ / ~~"supercharge your workflow"~~ — says nothing.
- ~~"Great for teams"~~ — see above.
- ~~"Replaces your engineers"~~ — the opposite of the pitch. Mars exists to
  make you *more* of an engineer, not less of one.
- **Don't lead with price.** "No API keys, no per-token bill" is true and
  good, and it's a supporting bullet. Evidence from current launches: offline
  / always-on / reliability framing outperforms cost-savings framing, and
  price is the one thing a competitor can copy by Friday.

---

## Open

- [ ] H1: literal "Cursor for engineers" vs. Mars's own words with the Cursor
      line in paragraph one — A/B on the launch post.
- [ ] Which structuring claim leads the README: the seal, or the derived-on-
      read queue.
- [ ] Whether to name Bernstein in the README itself or only in the launch
      post.
