# Harness health is a four-KPI vector defined over framework primitives; frugality is outcome-denominated not size-normalised; self-evolve is operator-owned and opt-in

Context: the project's success criteria are four standing goals — autonomy
(no human touch except planning), frugality (least tokens), resilience
(self-healing), and operator ergonomics (when a human *is* needed, the
decision is cheap and well-traced). The operator asked for "proper KPIs so
the harness can self-evolve." The substrate is already strong — per-step,
cache-weighted token accounting (`task_signals`, `step_spans.usage_signals`),
failure signatures + one-shot recovery (ADR-0002), and `reflect` /
`deep-reflect` that emit `source='reflection'` proposals — but three things
are missing: KPIs are recomputed and printed, never persisted (so drift
against a baseline is invisible); recovery effectiveness is not recorded
distinctly (a recipe that never works looks identical to one that always
does); and nothing closes the loop from a KPI regression back to corrective
work. A second framing landed mid-discussion and governs everything below:
Mars is an **agnostic agentic-workflow framework** whose self-coding repo is
merely the reference implementation, so KPIs must be defined over framework
primitives and carry no codebase assumptions.

Decision:

1. **Health is a KPI vector, not a scalar.** A single "harness health" number
is rejected because the four goals trade against each other (more autonomy
costs tokens and can hurt resilience; frugality — kill early, fewer retries —
hurts resilience). A regression is only meaningful held against the rest of
the vector. The canonical vector is exactly four members:
   - **Cost per completed Arc** — cache-weighted tokens summed per Arc,
     divided by Arcs that reached `done` over the window. The frugality
     headline.
   - **Failure rate** — fraction of Arcs whose origin reached `failed`. The
     reliability headline.
   - **Autonomous completion rate** — fraction of Arcs reaching `done` with
     zero Action-queue items raised. The autonomy headline.
   - **Recovery success rate** — fraction of origin failures whose recovery
     reached `done` and whose origin then reached `done`. The resilience
     headline.

2. **Frugality is outcome-denominated, never size-normalised.** Raw
tokens-per-task is rejected: tasks differ in size and the field has
implicitly rejected size normalisation (LOC/diff is gameable and weakly
correlates with difficulty — confirmed across SWE-bench, SWE-Effi, Devin's
ACU framing, none of which normalise by diff size). The accepted framing is
an outcome-denominated denominator (cost ÷ *completed* Arcs, after SWE-bench's
"cost per resolved issue"). Per-Arc token spend is additionally reported as a
**distribution (median + p90), never a bare mean**, because the size variance
lives in the distribution: a regressing p90 is signal, a regressing mean may
just be bigger legitimate work. As a rigorous backstop, **Effectiveness-under-
budget** (SWE-Effi-style success-rate-vs-spend AUC up to a budget cap, which
never divides per-task and so dissolves the size problem entirely) is computed
only during `deep-reflect`; Cost per completed Arc is the daily at-a-glance
number, Effectiveness-under-budget is the audit-grade view.

3. **KPIs are framework-agnostic.** Every KPI is defined over Arc / Task /
Worker / recovery / Action-queue primitives shared by every Mars deployment,
and never over codebase-specific artifacts. "Cost per completed Arc" holds for
any project; "cost per merged PR" or anything assuming a verify step or a
particular gate would not, and is forbidden. The reference implementation
(parallel coders, no review, no QA) is one configuration among many the
operator may choose.

4. **Self-evolution is operator-owned and opt-in; the framework never rewrites
itself.** The Self-evolve loop is: KPI drift → reflection → draft proposal →
**operator promotes** → merge → KPI re-measured. The human gate at promotion
is load-bearing — it keeps planning the single human touchpoint and means the
harness cannot queue work to change itself unsupervised. `deep-reflect` stays
the manual entry point to this loop. The automatic KPI-regression→proposal
**trigger is defined but gated behind an explicit operator opt-in switch, off
by default.**

Forward-looking (not mandated here): persisting a KPI time-series is a
prerequisite for detecting KPI drift and must exist before the loop has
meaning. **Recovery success rate is not capturable today and is deliberately
NOT given a schema/event mandate in this ADR**, because the workflow layer is
being reworked into a fully queryable surface; the four KPIs (recovery
effectiveness especially) are to be *derived from that surface* once it lands,
rather than bolted onto a model about to be replaced. This ADR fixes the
*definitions and constraints*; mechanism follows the workflow rework.

Alternatives rejected (recorded so they are not re-proposed): a single
composite health score (hides the trade-offs that are the whole point);
tokens-per-task or per-LOC normalisation (size-gameable, field-rejected); a
fully autonomous evolve loop with no human gate (violates the
planning-is-the-only-touchpoint principle); mandating recovery-outcome capture
on the current workflow model (would be obsoleted by the queryable-surface
rework in flight).

Cost: until KPI persistence and the queryable surface land, Recovery success
rate and KPI drift are named-but-not-yet-measured — the vector is defined
ahead of its full instrumentation, accepted because fixing the definitions now
prevents the workflow rework from baking in a narrower or codebase-coupled KPI
shape.
