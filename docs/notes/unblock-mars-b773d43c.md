# Unblock context: mars-b773d43c (demote internal-only exports)

Status: context note for the re-dispatched implementor of **mars-b773d43c**
("Demote internal-only `export` keywords and unused exported types").

## Why the first attempt died

The prior implementor was aborted with `too_hard:no-action-after-reads`.
Its entire read trail before the kill was **5 consecutive Greps, zero
edits**.

That is not the agent failing — it is the brief's prescribed method
colliding with the watcher:

- The brief says: "For EACH symbol below, before removing `export`, run
  the listed grep to confirm it has no importer outside its own file."
  There are ~30 symbols → ~30 greps.
- The orchestrator watcher SIGKILLs after **5** consecutive
  Read/Grep/Glob calls with no Edit/Write/Bash
  (`MARS_READ_SPAN_LIMIT`).

So the grep-every-symbol-first approach can never reach the first edit.
The task is structurally un-completable if executed literally.

## The actual missing context (do this instead)

Do **not** grep each symbol before editing. Be action-first and let the
TypeScript compiler do the verification — the brief itself already
designates `npm run build` as "the real safety net; any wrongly-demoted
symbol surfaces as a TS error here." That makes the per-symbol grep gate
redundant.

Recommended loop (never 5 reads in a row):

1. Open ONE file from the symbol list. Remove the `export` keyword from
   the listed symbol(s) in that file (keep the declaration). This is an
   Edit — it resets the watcher counter.
2. Move to the next file and repeat. Edits are interleaved with the only
   "reads" being the Read needed to make each Edit, so you never stack 5
   reads.
3. After a batch of files (e.g. every 4–6 files), run:
   `cd orchestrator && npm run build`
   A symbol that actually had an external importer fails to compile at
   its import site. For each such error, restore `export` on just that
   one symbol and note it in the commit message. This is exactly the
   per-symbol verification the brief wanted — done by `tsc`, in bulk,
   without tripping the watcher.
4. When the full list is processed and `npm run build` is clean, run
   `cd orchestrator && npm test`.
5. Commit. The brief permits partial completion, but the build-driven
   approach above can safely process the whole list in one pass.

Test files that import internals by direct module path are allowed to
keep an export alive — the same way: if `npm run build` / `npm test`
goes red because a `*.test.ts` imports a demoted symbol, restore that
one `export` and note it.

## Scope reminders carried over from the parent brief

- DEFER (do not touch): `context.ts:resolveRepo` (parallel impl in
  `ui/`) and the `AbExperiment*` types (registered workflow).
- Load the `mastra` skill before editing anything under
  `orchestrator/src/mastra/**`.
- Removing `export` only — never delete the symbol itself.

## For the orchestrator / re-dispatch

The parent prompt's "grep before each symbol" instruction should be read
as advisory, not literal: the build is the gate. No code dependency is
missing; the blocker was purely method-vs-watcher. Re-dispatch is safe
with the action-first loop above.
