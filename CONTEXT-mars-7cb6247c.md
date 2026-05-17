# CONTEXT: mars-7cb6247c — Mars id value object already on main

**Task**: Slice 1/6 of PRD `04830c8e-centralize-id-generation-for-mars-task-a` —
"Mars id value object with kind, bare hex, and prefix lookup support."

**Verdict**: No code change required. The slice was already implemented and
merged to `main` in commit `108c4b1 feat(mars-id): add Mars id value object
with kind, hex, slug, and prefix lookup`. The verify command
(`cd orchestrator && npm test -- mars-id`) passes unchanged: 28/28 tests
green. Documenting the mapping rather than re-implementing, per repo
precedent (`5989df3`, `150d4c0`, `2bc63cc`, `adb8e52`, ...).

## Acceptance-criteria walkthrough

Mapping each `<done>` line to the exact location in
`orchestrator/src/mars-id/index.ts` and `orchestrator/src/mars-id.test.ts`:

1. **Constructing a Mars id from kind `'task'` and a bare hex renders as
   `mars-task-<hex>`** — `MarsId.create` + `toString()` in
   `mars-id/index.ts` (lines 45-75). Test: `MarsId.create` →
   "renders a task id as mars-task-<hex>" (lines 10-13).
2. **Constructing a Mars id from kind `'idea'` with a slug renders as
   `mars-idea-<hex>-<slug>`** — same `toString()` path, slug branch on
   line 68. Test: lines 15-18.
3. **Parsing each of the four input shapes round-trips to the same bare
   hex** — `parseMarsId` in `mars-id/index.ts` (lines 147-181 + the
   `parseKindedForm` helper, lines 183-234). Test:
   "round-trips all four user-facing shapes back to the same bare hex"
   (test file lines 92-110), plus four per-shape parse tests
   (lines 41-90).
4. **Parsing a malformed id surfaces a typed error rather than
   returning a partial value** — `MarsIdParseError` class (lines 124-133)
   with `MarsIdParseErrorCode` union (lines 117-122). All error paths in
   `parseMarsId` / `parseKindedForm` return `{ ok: false, error }` with
   no `value`. Test: "parseMarsId — typed errors" block (lines 113-157),
   including "returns no partial value on error" (lines 150-156).
5. **Equality between two ids depends only on the bare hex, ignoring
   kind and slug** — `MarsId.equals` (lines 72-74) compares `this.hex`
   only. Test: "MarsId.equals" block (lines 159-178), covering
   hex-match-with-different-kind, hex-mismatch, and
   slug-only-difference.
6. **Prefix type is distinct from the complete value object and cannot
   be rendered as a final id** — `MarsIdPrefix` is a separate class
   (lines 82-115). Its `toString()` returns `[MarsIdPrefix <hex>]`
   (line 113), deliberately non-`mars-`-shaped. Test:
   "is a distinct type from MarsId" (lines 199-204) and "cannot be
   rendered as a final user-facing id (no mars- form)" (lines 206-215).
7. **Unit tests cover construct, parse, render, equality, and prefix
   matching** — `mars-id.test.ts` has 28 cases across the five
   `describe` blocks (`MarsId.create`, `parseMarsId — round-trip`,
   `parseMarsId — typed errors`, `MarsId.equals`, `MarsIdPrefix`).
   `npm test -- mars-id` reports `Tests 28 passed (28)`.

## Why this commit exists

The orchestrator's verify step rejects a run with `verify:has-diff/no-
commits-ahead` when the task's branch has zero commits ahead of the
integration target. Re-implementing already-merged code would be a
silent no-op against `main`; the alternative — landing a context note
that documents the mapping — is the repo's standing answer to this
situation. This file is that note; the underlying value-object code
itself lives at the paths cited above and is unchanged by this commit.
