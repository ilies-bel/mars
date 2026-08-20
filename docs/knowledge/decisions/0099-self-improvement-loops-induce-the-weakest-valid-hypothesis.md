# Self-improvement loops induce the weakest valid hypothesis

# Self-improvement loops induce the weakest valid hypothesis

## Status
Accepted

## Context
Mars's self-improvement loops (reflect, deep-reflect, failure-reflector,
learned recipes, gate enrichment, triggers) induce reusable rules from
observed task arcs. Bennett, "The Optimal Choice of Hypothesis Is the
Weakest, Not the Shortest" (arXiv:2301.12987), proves that to maximise the
probability an induced hypothesis generalises, it is necessary and
sufficient to pick, among hypotheses VALID on the evidence, the WEAKEST —
the least specific one ("explanations should be no more specific than
necessary"). An audit (2026-08-21) found Mars violates both halves: no loop
validates an induced rule against the instances it was derived from
(burn-in only proves a gate can parse, `affectedTaskIds` is prose, no
did-this-work feedback exists), and the matching layer is maximally
specific (learned recipes match on exact signature equality from n=1;
failure clustering groups on exact signatures; deep-reflect induces
file-specific rules from single arcs). The LLM reflector prompts are
unguided on the specificity axis — except deep-reflect's scorer rubrics,
which already demand generalisation to future instances.

## Decision
Every rule induced by a self-improvement loop obeys two requirements:

1. **Validity on evidence.** A rule must be checked against the instances
   it was induced from before adoption — via replay where the eval harness
   permits, or at minimum an explicit coverage claim over every cited
   instance. Adoption without this check is a bug. Outcome feedback
   (did acting on the rule help?) is a required signal, not optional.
2. **Weakness, bounded by blast radius.** Among valid rules, prefer the
   least specific — reflector prompts must ask for the least-specific rule
   that still covers all cited instances; clustering and suggestion
   matching use the widened signature family, not exact strings. The
   exception is autonomous actions (learned recipes, steward edits):
   these stay narrowly matched, and any widening must be bounded and
   justified (the `failureSignatureFamily` pattern). Weakness applies to
   what we BELIEVE; specificity governs what we DO unattended.

Every matcher records its breadth (how many past instances it would have
fired on), so over-narrow and over-broad rules are both measurable.

## Consequences
- Reflector/deep-reflect/failure-reflector prompts gain an explicit
  least-specific-valid-rule instruction, modeled on the existing scorer-
  rubric clause; deep-reflect single-arc suggestions need corroboration
  (the skill-forge ≥3-arc pattern) or reduced standing.
- Gate burn-in adds replay-against-motivating-failures to its promotion
  criteria; the eval harness (regression fixtures) is the substrate.
- The failure-cluster detector and suggestion dedup move from exact
  signatures to signature families.
- Learned recipes stay exact-match but gain a breadth metric and an
  outcome log consulted before re-firing.
