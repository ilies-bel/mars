# Unblock note for mars-c78cb94b

- **This task:** `mars-c78cb94b`, slice 1/2 of PRD
  `b0e867bf-audit-the-repo-for-references-to-the-leg`, "Sweep
  instructional docs for legacy 'ready' lifecycle references".

## Why this slice is a no-op

Every acceptance criterion the slice asks for is **already on main**.
The relevant rewrite landed in commit `12497f8`
("docs: rewrite README task-status table to drop legacy 'ready'
lifecycle wording"), which was the original slice 1 of this same PRD.
This task appears to be a re-dispatch of the same slice after the
earlier completion was not propagated back to the PRD's slice plan.

## Verification

Running the slice's `verify` command from `orchestrator/` against the
listed instructional docs:

```
rg -n '\bready\b|mars ready' README.md CLAUDE.md AGENTS.md \
   orchestrator/README.md orchestrator/AGENTS.md \
   .claude/commands .agents
```

produces six hits. None are Mars task-lifecycle context:

| Hit | Why it's preserved |
| --- | --- |
| `orchestrator/AGENTS.md:18` — "Build a production-ready server" | Build description, not lifecycle. |
| `README.md:154` — `status=prd-ready` | `ideas`-table status, not task lifecycle. |
| `README.md:241` — "PRD-ready idea" | Idea-status concept, not task lifecycle. |
| `AGENTS.md:8` — `bd ready` | `bd` (beads) tool command, unrelated to Mars. |
| `AGENTS.md:47` — `bd ready` | Same — beads command. |
| `AGENTS.md:82` — "ready to push when you are" | Colloquial English, not lifecycle. |

The slice brief explicitly says non-lifecycle phrases must be preserved
unchanged, so all six are correct to leave.

Searching for `mars ready` across the same set returns zero hits.

## Acceptance criteria, item-by-item

- [x] **Zero lifecycle-context 'ready' hits** across the listed
  instructional docs. Confirmed above — the six remaining hits are all
  non-lifecycle.
- [x] **Zero 'mars ready' hits.** Confirmed — the search returns
  nothing for that phrase.
- [x] **At least one rewritten passage states 'queued' is the
  claimable state and is auto-claimed once functional and technical
  plan sections are both non-empty.** Already present at
  `README.md:228`:

  > `queued` | The claimable state — the daemon picks up tasks
  > directly from `queued`. A task auto-promotes from `draft` to
  > `queued` once its functional and technical plan sections are both
  > non-empty.

- [x] **Non-lifecycle 'ready' phrases preserved unchanged.** All six
  hits above are intact on main.
- [x] **Every edited file still reads as coherent prose.** No edits
  were needed in this dispatch; the prose rewritten in `12497f8`
  remains coherent.

## Notes on the verify command

The slice's `verify` includes `.claude/commands` as a path, but that
directory does not exist in this repo. The repo's Claude Code skill
layout uses `.claude/skills/` and `.claude/agents/`; both were also
scanned (`rg -n '\bready\b|mars ready' .claude/skills .claude/agents
.agents/skills`) and return zero hits. Because `rg` errors with exit
code 2 on the missing path, the verify command as written will exit
non-zero even though every acceptance criterion is met. Worth a
follow-up to align the verify with the repo's actual skill layout
(e.g. `.claude/skills .claude/agents` instead of `.claude/commands`),
but that is a verify-script fix, not part of this slice's intent.

## Recommendation

Transition `mars-c78cb94b` straight to `done`. No source edits are
needed; the acceptance criteria are met by prior work on main.
