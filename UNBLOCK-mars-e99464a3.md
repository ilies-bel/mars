# Unblock note for mars-e99464a3

- **Parent task:** `mars-e99464a3` — slice 1/6 of PRD
  `b696c34b-replace-install-sh-with-a-mars-install-c`, "Land
  Bundle/Owned/Hybrid glossary terms and Hybrid-refuse ADR".
- **This task:** `mars-b936f3b1`, the context-gathering child dispatched
  after the implementor for `mars-e99464a3` was killed with
  `too_hard:no-action-after-reads` (5 reads, 0 edits).

## Why the implementor stalled

Every acceptance criterion the slice asks for is **already on main**.
The implementor read files looking for what to add and found nothing to
do, so the read-span watcher killed it.

| Acceptance criterion | Current state on `main` |
| --- | --- |
| Glossary entry for `Bundle` | Present. `mars glossary show "Bundle"` — defines it as the per-version tarball with `manifest.json` and the union of owned+hybrid paths, with a `.sha256` sidecar. |
| Glossary entry for `Owned file` | Present. `mars glossary show "Owned file"` — references ADR-0004 for unconditional overwrite. |
| Glossary entry for `Hybrid file` | Present. `mars glossary show "Hybrid file"` — "writes only if absent; if present, refuses and tells user to back up and remove." |
| ADR on Hybrid-refuse | Present as `docs/adr/0007-hybrid-files-in-mars-install-refuse-on-existence.md`, discoverable via `mars adr list`. Numbered consistently with 0001–0014. |
| ADR cross-references ADR-0004 (owned overwrite) | **Yes** — body explicitly says "same spirit as ADR-0004". |
| ADR cross-references ADR-0005 (semver tags) | **No.** ADR-0007 does not mention ADR-0005. This is the *only* unmet criterion. |
| Entries added through structured-write CLI, not by direct edits | Already true — both `mars glossary set` and `mars adr add` route through the daemon. |

## Why the implementor cannot fix the one remaining gap

ADRs are append-only (`mars adr add` only; never direct edits per
`CLAUDE.md`). There is no `mars adr update` / `mars adr edit`. The
implementor cannot retroactively cross-reference ADR-0005 from ADR-0007
without violating that invariant.

Two ways out, neither of which the implementor should silently pick:

1. **Mark the slice done.** The cross-reference omission is cosmetic —
   the ADR's *substance* (refuse-on-existence, no merge, no conflict UI)
   is intact and ADR-0004 already establishes the policy axis. ADR-0005
   is about versioning, which is orthogonal to refuse-on-existence; the
   cross-reference would be informational, not load-bearing. Recommend
   the orchestrator transitions `mars-e99464a3` straight to `done`.

2. **Land a new amendment ADR.** If the cross-reference is considered
   load-bearing, append ADR-0015 titled along the lines of
   "Hybrid-refuse references semver versioning (ADR-0007 amendment)"
   that explicitly chains 0007 → 0005. This costs a numbered ADR slot
   for a one-paragraph footnote and is probably overkill.

## Recommended next step

Close `mars-e99464a3` as `done` (option 1). All user-visible behaviour
the slice describes is already reachable from `main`:

```
mars glossary show "Bundle"
mars glossary show "Owned file"
mars glossary show "Hybrid file"
mars adr show 0007
```

If the maintainer insists on the ADR-0005 back-reference, file it as a
fresh small task ("Add ADR-0015 noting ADR-0007 implicitly assumes the
semver-tag versioning of ADR-0005") rather than reopening this slice.
