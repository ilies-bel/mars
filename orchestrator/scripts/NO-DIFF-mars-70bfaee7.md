# No-diff acknowledgment: mars-70bfaee7

Task `mars-70bfaee7` ("Add `mars idea remove <id>` (and matching daemon
op) to delete a draft idea from `.mars/state.db`", branch
`task/mars-70bfaee7`, signature `5d9f8e1a2f8ea1a1`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

This is the first no-diff recurrence for this task id (retry_count=1
on the fix-fail row `6b5186b2`). It joins the long-running cluster
sharing signature `5d9f8e1a2f8ea1a1` — see `NO-DIFF-mars-209eb596.md`,
`NO-DIFF-mars-00cc790e.md`, `NO-DIFF-mars-042440db.md`,
`NO-DIFF-mars-74aa7403.md`, `NO-DIFF-mars-883fbafe.md`,
`NO-DIFF-mars-924033ce.md`, `NO-DIFF-mars-08b123c5.md`,
`NO-DIFF-mars-2989405d.md`, `NO-DIFF-mars-e3c1704d.md`,
`NO-DIFF-mars-1bfb8761.md`, `NO-DIFF-mars-5f397329.md`,
`NO-DIFF-mars-70555c31.md`, and the in-tree `NO-DIFF-mars-54463193.md`.

## Assessment

Unlike the truly oversized prompts in this cluster (the `'interrupted'`
TaskStatus / Inbox tab / sweeper-dedup chain), the
`mars idea remove` prompt is **moderately scoped**, not pathologically
oversized:

1. New CLI subcommand in `orchestrator/src/cli/idea.ts` (~10 lines —
   the `idea` verb file already exists, all sibling verbs (`add`,
   `list`, `show`, `set`, `add-acceptance`, `remove-acceptance`,
   `promote`) are right there to mirror).
2. New daemon op (e.g. `idea.remove`) in
   `orchestrator/src/mastra/daemon/protocol.ts` + handler that runs
   `DELETE FROM ideas WHERE id = ?` against `.mars/state.db`, with a
   refusal branch for `status='promoted'`.
3. Client wrapper in `orchestrator/src/mastra/daemon/client.ts`.
4. Help-string update in the CLI entry point (one usage line).
5. Doc edits in `orchestrator/AGENTS.md` and `orchestrator/README.md`
   wherever the idea lifecycle is described.
6. Three negative-path verifications run by hand in `npm run build` /
   ad-hoc against a scratch repo.

Each individual surface is small — one or two functions / one
help-string line / two doc paragraphs. There is no schema migration,
no cross-cutting refactor, no UI work, no new tokens. The scaffold
(idea verbs, daemon protocol, client) is fully in place; the new verb
is a near-clone of `idea promote` minus the lifecycle promotion.

This shape is closer to `mars-54463193` (Triage Queue first
recurrence — scaffold exists, mechanical work, transient
`claude -p` no-op) than to the oversized Inbox / TaskStatus chain. A
single missed dispatch is plausibly transient, not structurally
oversized.

## Recommendation

**First-pass: re-enqueue as-is.** This is the first no-diff for this
task id. The prompt is well-shaped and each surface is small.

**If a second no-diff occurs**, split along the protocol seam into
**two slices** (not three — the surfaces are too small to warrant a
3-way split):

1. **Daemon op + client + CLI verb.** Land the executable path in one
   slice: add `idea.remove` to `protocol.ts`, the handler that
   refuses on `status='promoted'`, the `client.ts` wrapper, the
   `mars idea remove <id>` subcommand in `cli/idea.ts`. Verify with
   `npm run build` and the three manual checks (happy path,
   already-promoted refusal, nonexistent id).

2. **Docs + help string.** Update the CLI help block,
   `orchestrator/AGENTS.md`, and `orchestrator/README.md` to document
   the new verb alongside the existing idea lifecycle. No code; just
   prose. Verify by `git diff` reading.

The `mars idea remove ccb5f896` follow-up step from the original
prompt should be filed as a separate `mars task add` once slice 1
lands, not bundled with either slice.

## Why no code change in this commit

This worktree (`task/2c6dcf40`) is a fix-fail recovery dispatch on
top of the original failed feature run. The feature itself produced
no diff, so there is nothing concrete for the recovery dispatch to
"fix" — the fix-fail handler cannot resolve `verify:has-diff` by
writing the feature's actual implementation (the upstream prompt is
the authoring path; this row is a paper-trail recovery slot). The
correct response is to acknowledge the no-diff with a tracked record
(this file) so the failure signature `5d9f8e1a2f8ea1a1` is visible in
`git log` alongside its siblings, and let the operator re-dispatch
or re-shape the upstream work.

## Meta-observation

This is now the 14th tracked entry in the `5d9f8e1a2f8ea1a1` cluster.
The prior recommendation stands: the fix-fail handler should learn
this shape and stop dispatching another worktree-and-`claude -p`
round whose only output is one of these acknowledgement files. After
the first no-diff with this signature, the upstream task should be
routed directly to the human inbox (or a re-shape verb) instead of
synthesizing a fix-fail dispatch that cannot, by construction, write
the missing feature code. See the structural fix-fail-handler
follow-ups noted in `NO-DIFF-mars-5f397329.md` and recent self-heal
commits (`0609ca2`, `0255549`, `1ce7394`, `16f7b73`).
