# Path-containment verify selection with always-on root floor

When the orchestrator runs the `verify` step of an implement workflow it
must decide *which* verify steps apply to *this* task. A single-language
repo could run every step blindly, but a multi-language, full-stack repo
cannot: a backend-only change should not be gated on the frontend's
type-check, and a docs-only change should not run either. The signal for
"which scopes does this task touch" has to come from somewhere, and this
ADR pins where.

**Decision: verify-step selection is path-containment of the actual task
diff against each step's directory, and the repo-root scope is an
always-on invariant floor — not a fallback-only case.** Concretely: for
each `VerifyStep` in the recipe, the step's `cwd` (defaulting to the repo
root when absent) is treated as that step's *scope key*. A step is
selected iff at least one path in the task's changed-file set is contained
within that step's directory. Independently of any path match, every step
whose scope key is the repo root **always** runs. The root floor is an
invariant, not a default that disappears once a narrower scope matches: a
task that changes both `orchestrator/` and a root-level file runs the
orchestrator-scoped steps *and* the root-scoped steps; a task that touches
only a leaf directory still runs the root-scoped steps. This guarantees
there is no task shape that silently skips repo-wide checks.

This decision deliberately reuses, and does not extend, the verify-recipe
contract. **ADR 0003 (slim verify recipe lives at `.mars/verify.json`) is
a binding constraint here.** The per-step directory is the *same*
`cwd` field that ADR 0003 already pins as part of the `VerifyStep` shape
(`{ kind, command, cwd?, timeoutMs? }`); this ADR reuses it as the scope
key rather than introducing a parallel notion of scope. There is **no
recipe schema change**: no new field on `VerifyStep`, no new top-level key
on the recipe, no version bump, and no migration. This ADR does **not**
amend ADR 0003 — the recipe shape, path, and migration read-source stay
exactly as 0003 specifies. Selection is a pure function of (the existing
recipe, the task's changed-file set); it adds behaviour around the recipe,
not inside it.

**Rejected alternative: a per-task scope column.** Storing the resolved
scope(s) for a task in the queue/state schema (e.g. a `scope` column on
the task row, written at enqueue or slice time) was rejected. It
duplicates information that the changed-file set already carries
authoritatively, and the two will drift: the column is written before the
code exists, but the scopes a task *actually* touches are only known once
the diff exists. A task that grows or shrinks its footprint mid-implement
(a common, legitimate outcome of coding) would then be verified against a
stale scope. It also adds a schema migration and a write path for a value
that is always derivable, for no gain in fidelity — strictly worse than
deriving it from the diff at verify time.

**Rejected alternative: an explicit stored scope list.** Having the
slicer (or the author of a free-prose task) declare an explicit list of
scopes the task is allowed to touch, stored alongside the task, was also
rejected, for the same drift reason plus a correctness hazard. A declared
list is a *prediction*; the diff is *ground truth*. If the declared list
under-covers the real diff, repo-wide or cross-scope checks are skipped
precisely when they matter most (the task did something its author did not
anticipate). If it over-covers, we run irrelevant steps and lose the
selectivity the whole feature exists to provide. The changed files plus
the existing recipe already carry the entire signal; a second,
hand-maintained source of truth can only disagree with the first, and
when it disagrees it does so silently.

Trade-off accepted: selection now depends on computing the task's
changed-file set at verify time (a diff against the integration base),
which is one extra cheap git operation per verify run. In exchange,
scope is always exact, never stale, requires no schema change, and the
root floor makes it impossible to construct a task that evades repo-wide
verification. The per-step `cwd` remaining the single scope key keeps the
recipe the one place scopes are defined, consistent with ADR 0003.
