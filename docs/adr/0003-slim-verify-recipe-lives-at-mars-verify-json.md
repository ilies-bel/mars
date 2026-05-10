# Slim verify recipe lives at .mars/verify.json

After the per-stack supervisor concept is removed, `mars init` no longer
detects a stack, fetches specialist prompts, writes per-scope `AGENTS.md`
blocks, or maintains `.mars/supervisors/<name>.md`. The only durable
artifact `mars init` still needs to produce is the **verify recipe** the
orchestrator reads when it runs the `verify` step of an implement
workflow.

**Decision: the slim verify recipe lives at `.mars/verify.json`.** The new
shape is exactly `{ version: 1, generatedAt: string, verifySteps:
VerifyStep[] }`, where `VerifyStep` is the same per-step contract the
existing per-supervisor `verify` field already uses (`{ kind, command,
cwd?, timeoutMs? }`). The legacy manifest's `stack`, `supervisors`, and
`removed` fields are dropped, and the per-supervisor wrapper around verify
entries is flattened to the top level. The `.mars/supervisors/` directory
is removed entirely by a later slice in this PRD; this ADR only pins the
target shape and path so subsequent slices have an unambiguous goal.

Chosen because the path name has to match what the file actually is once
the supervisor concept is gone. Keeping the slim file at
`.mars/supervisors/manifest.json` would leave a directory whose only
remaining file contradicts its parent's name, and every future reader
would have to learn that "supervisors" is historical baggage. Moving to a
top-level, single-file `.mars/verify.json` makes the artifact
self-describing; the cost — one migration read on first run after upgrade
— is paid once. Trade-off: existing repos with hand-tuned verify steps
under the old manifest must not lose them silently, so this ADR also
pins the migration read-source.

**Migration read-source: read old, write new, leave the old file in
place.** The first time any consumer of the verify recipe runs after this
PRD lands and finds no `.mars/verify.json`, it MUST read `verifySteps` by
flattening every `supervisors[].verify` entry from the legacy
`.mars/supervisors/manifest.json`, deduping by `(kind, command)`, and
writing the result to the new path. The legacy manifest is left on disk
by this PRD; a follow-up slice removes the `.mars/supervisors/` directory
once we are confident no consumer still reads it. Chosen because the
operation is idempotent and reversible — a maintainer can `rm
.mars/verify.json` and re-run to regenerate, and the legacy file remains
as a fallback if a regression is found mid-rollout. Alternatives
considered: (a) atomic read-and-delete in one step — cleaner end-state
but harder to roll back inside the PRD; (b) no migration, force users to
re-run `mars init` — hostile to repos with hand-tuned verify steps and
not actually simpler, since `mars init` itself needs the migration path
to bootstrap legacy installs. The "leave old in place" option preserves
the rollback escape hatch without leaking the legacy concept into the
new shape.
