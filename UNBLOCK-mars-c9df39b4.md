# Unblock note for mars-c9df39b4

- **This task:** `mars-c9df39b4`, slice 3/6 of PRD
  `578ab441-design-a-per-blocked-task-recovery-timel`, "Design draft
  for the side-panel that opens when an operator clicks a node in the
  dependency graph". Type: HITL.

## Why this slice is a no-op

Every acceptance criterion the slice asks for is **already on main**.
The relevant artefact landed in commit `a286221`
("design(dependency-graph): side-panel mock (slice 3/6)"), which was
the original slice 3 of this same PRD. This task appears to be a
re-dispatch of a slice that has already been delivered.

The worktree's `main..HEAD` count is `0` — the branch tracks main and
the side-panel mock is already reachable from main at the path the
brief names (`design/dependency-graph/side-panel.pencil`, 1057 lines).

## Verification of the four acceptance criteria

The brief lists four `<done>` items. Each is satisfied by the on-disk
file, with the supporting evidence inline below (line numbers refer to
`design/dependency-graph/side-panel.pencil`).

### 1. Mock A labels every required field

Required: failure signature, fix-task link, worktree path, final
commit, error text, blocker list, inbox deep-link.

| Field | Section header on Mock A |
| --- | --- |
| failure signature | `field: failure signature` (L187) → label `FAILURE SIGNATURE` (L197) |
| fix-task link | `field: fix-task link` (L219) → label `FIX-TASK` (L229), value annotated as intra-graph link, not a write action (L238) |
| worktree path | `field: worktree path` (L251) → label `WORKTREE PATH` (L261) |
| final commit | `field: final commit` (L283) → label `FINAL COMMIT` (L293) |
| error text | `field: error text` (L315) → label `ERROR TEXT` (L325) |
| blocker list | `field: blocker list` (L391) with per-blocker reasons (e.g. L451) |
| inbox deep-link | `field: inbox deep-link` (L521) → label `INBOX` (L531), value `Open in /mars:inbox  →  recovery-failed: …` (L565) |

The artboard's closing checklist (L1017) restates this:

> ✓ All required fields labelled on Mock A: FAILURE SIGNATURE,
> FIX-TASK, WORKTREE PATH, FINAL COMMIT, ERROR TEXT, BLOCKED BY,
> INBOX.

### 2. Mock B renders absent fields as absent, not empty placeholders

Mock B caption (L653):

> B. Node with no failure signature and no inbox item

Mock B sub-caption (L663):

> Healthy in-flight task — never failed, never produced an inbox
> item. Absent fields are removed from the panel, not shown as empty
> placeholders.

The panel's top-of-mock callout (L762) names which sections are
omitted entirely:

> Not shown for this task: FAILURE SIGNATURE, INBOX  ·  this task
> has not failed and has not produced an inbox item, so those
> sections are omitted entirely.

The rule itself is stated explicitly at L980:

> Absent-field rule: sections that cannot apply (FAILURE SIGNATURE,
> INBOX) are omitted from the panel entirely and called out once at
> the top. Sections that may apply but happen to be empty for this
> particular task (FIX-TASK, FINAL COMMIT, ERROR TEXT, BLOCKED BY)
> keep their label and replace the value with explicit italic prose
> — never '(none)', never an empty input.

And the closing checklist (L1027):

> ✓ Mock B has no failure signature and no inbox item — both are
> removed from the panel and explained once at the top, not rendered
> as empty placeholders.

### 3. Inbox deep-link visibly styled as a navigation affordance

Mock A's INBOX value (L565, L578) and the closing checklist (L1037):

> ✓ Inbox deep-link styled as a navigation affordance: arrow icon
> (↗), link-color stroke + underlined link-color text, label reads
> 'Open in /mars:inbox'. Distinct from any button styling.

Reinforced by the artboard header (L49):

> No write controls (no Resolve / Retry / Unblock buttons). Inbox
> link is a navigation affordance — clicking it routes to
> /mars:inbox, never acts in place.

And by the note above Mock A (L632):

> Note: nothing in this panel is a write control. The single
> primary-color element is the inbox deep-link, which is a
> navigation affordance — arrow icon (↗), link-color stroke and
> text, underline. No 'Resolve', 'Retry', or 'Unblock' buttons
> appear anywhere.

### 4. No write controls anywhere in the panel

Footers on both mocks (L617, L965):

> Read-only. Resolve / retry / unblock live in /mars:inbox and the
> CLI.

Closing checklist (L1047):

> ✓ No write controls (Resolve / Retry / Unblock) appear in either
> mock; footer reiterates that those actions live in /mars:inbox
> and the CLI.

## Recommendation

Close this slice as done. No edits to
`design/dependency-graph/side-panel.pencil` are necessary — the
mock on main already covers the four acceptance criteria.

If the orchestrator's slice tracker has lost track of slice 3/6's
completion, that is the underlying defect worth filing separately;
it is the same failure mode that produced `f03df66` for PRD
`b0e867bf`.
