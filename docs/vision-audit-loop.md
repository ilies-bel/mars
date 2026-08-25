# Vision audit loop — the prompt

Run in a separate terminal, from the repo root:

```
/loop 20m Audit Mars against VISION.md. <paste the prompt below>
```

Or paste the prompt alone and let it self-pace with `/loop`.

---

## The prompt

You are auditing Mars against its own north star. One claim per iteration. Depth
over coverage — a single claim genuinely tested beats five skimmed.

**1. Load state.**
Read `VISION.md`. Read `.mars/vision-audit/ledger.md` (create it if absent, with
the heading `# Vision audit ledger` and nothing else). The ledger records every
claim already tested, its verdict, and what you filed. Never re-test a claim the
ledger marks `HOLDS` unless the code under it has changed since.

**2. Pick one claim.**
From `VISION.md` §8, take the highest-priority claim not yet in the ledger. If
§8 is exhausted, pick a hard requirement (§3) or decision (§4) that §8 has no
test for — then write that test into §8 (see step 6; appending is allowed).

**3. Test it through the UI.**
The UI is the operator surface (HR-2), so a claim tested through the CLI has not
been tested where it is made. Start it if it is not running (`mars ui`, default
`:7777`) and drive it with the browser tools. Read what an operator would read:
the rendered text, the affordances actually present, what happens when you click.

Two exceptions where the UI is not enough:
- **Onboarding claims (DEC-14/15/16)** need a repo Mars has never seen. Create a
  throwaway git repo under your scratch directory, install into it, and watch.
  Never run onboarding against this repo.
- **Idle claims (DEC-17)** need observation over time, not a click.

Confirm the daemon is up before concluding anything: a dead daemon reads as
"no alerts", which is *unknown*, not a pass.

**4. Judge.**
Verdict is one of:
- `HOLDS` — you observed the behaviour the claim promises.
- `BROKEN` — you observed the falsifying condition. Say exactly what you saw.
- `UNTESTABLE` — the claim as written cannot be checked. That is a defect in the
  vision, not in the code.

Do not accept "the code appears to do this" as `HOLDS`. You must have observed it.

**5. Act.**
- `BROKEN`, and the fix is unambiguous → `mars task add` it yourself. One task per
  defect. The prompt must stand alone: file path and symptom, the vision claim it
  violates by number, the suggested fix, a scoped `--verify` command relative to
  the worktree root, and a closing "Save your work" line.
- `BROKEN`, but the right fix is a judgment call → `mars proposal add`. State both
  readings and which you would take. The operator grills it.
- `UNTESTABLE` → `mars proposal add` describing what the claim would have to say
  to be checkable.
- `HOLDS` → nothing. Record it and move on.

**6. Write back.**
Append your verdict to the ledger: claim id, date, verdict, what you observed,
what you filed.

You may **append** to `VISION.md` — a missing falsification test, an open question
that got settled, a decision taken but never written down. You may **never**
revise it: do not rewrite a decision, soften a hard requirement, or delete a line
because the code disagrees. When reality contradicts the vision, **the code is
wrong** until the operator says otherwise — file a proposal and leave the text
alone.

**7. Report.**
One short paragraph: which claim, what you did, the verdict, what you filed. If
nothing was wrong, say so plainly — a quiet iteration is a real result.

## Rules

- Never restart the daemon, purge a task, or remove a worktree. Those are the
  operator's calls.
- Never `git stash`. Never commit to `main`.
- If a browser action fails three times, stop and report rather than working
  around it.
- If the daemon is down, say "unknown", not "clean".
