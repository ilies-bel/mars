# No-diff acknowledgment: mars-74aa7403

Task `mars-74aa7403` ("Add a 'mars monitor' TUI subcommand…", branch
`task/mars-74aa7403`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

Failure signature: `5d9f8e1a2f8ea1a1`. Task status in the queue: `blocked`.

## Why this is a third no-op, not a new diagnosis

The prompt body of `mars-74aa7403` is the same 'mars monitor' TUI spec
already triaged twice before — once as `mars-883fbafe`, once as the
fix-fail row immediately after. Both prior dispatches landed in the
no-diff state for the same shape reason:

> The acceptance criteria span four loosely-coupled surfaces — daemon
> per-slot identity, bus events + `/status`, SSE forwarding, and a new
> Ink TUI tree — well above one `claude -p` budget under the 100-message
> cap (`MARS_CLAUDE_MAX_MESSAGES`, commit `2242e1f`).

See `NO-DIFF-mars-883fbafe.md` for the full diagnosis and the recommended
4-way split (per-slot identity → bus events + `/status` → Ink scaffold →
rendering polish). That decomposition is still the right answer; nothing
about the failure mode changed between `mars-883fbafe` and
`mars-74aa7403`.

## Why this fix-fail commit is itself diff-only-as-doc

The structural fix is **planning** — splitting the monolith prompt into
four `mars task add` rows the operator enqueues by hand — not code that
belongs in a worktree diff. The block-tracked-writes hook also forbids
direct edits to `CONTEXT.md` / `docs/adr/**` from a coding worktree, so
the only correct on-disk artifact for this fix-fail row is this
acknowledgment, mirroring the pattern of `4a9e9da` for `mars-883fbafe`.

## Operator action: stop retrying the monolith

Three consecutive no-diff dispatches against the same prompt shape is
the signal that the **two-strikes drop-and-reshape** rule already filed
as a follow-up in `NO-DIFF-mars-883fbafe.md` ("Real follow-up", second
bullet) is now overdue. Until that auto-route lands, the operator should:

1. Drop / archive `mars-74aa7403` rather than re-enqueue it as written.
2. Enqueue the four follow-up tasks from `NO-DIFF-mars-883fbafe.md`
   §"Recommended split" verbatim, each with a one-line backref to that
   file so the dispatched agent has the *why*.
3. File the planner-side rule (oversized-prompt detection at
   `mars task add` time, plus auto-reshape after two strikes) as a
   separate task — not bundled into any of the four feature slices.

Out of scope for this acknowledgment commit.
