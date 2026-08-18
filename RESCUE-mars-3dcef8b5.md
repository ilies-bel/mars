# Rescue-operator verdict: arc mars-3dcef8b5

**Rescue task:** mars-366daa5f
**Arc origin:** mars-3dcef8b5 (status: blocked)
**Recovery fix task:** fix-6b227c76 (status: running)
**Failure signature:** code:context-exhausted/unclassified

## Investigation

- `mars-3dcef8b5` failed mid-code with `code:context-exhausted: context budget
  exhausted (maxContextTokens) mid-code; the worktree holds in-progress work
  to resume`. `recovery_spawned_count=1` — the standard one-recovery-per-origin
  mechanism already spawned `fix-6b227c76` on the *same* branch/worktree
  (`task/mars-3dcef8b5`, shared `worktree_path`), matching CLAUDE.md's
  "code-phase failure auto-commits any dangling changes as a salvage
  checkpoint, then resumes the coder" behaviour.
- The arc snapshot handed to this rescue task showed `fix-6b227c76` as
  `queued`; by the time this rescue task actually investigated, the daemon
  had already dispatched it — DB shows `status='running'`, `updated_at`
  advancing every ~1 minute (15:46 → 15:47 → 15:50), i.e. an actively
  progressing session, not a stall.
- The origin worktree
  (`.mars/worktrees/mars-3dcef8b5`) is on `main` (0 commits ahead) but holds
  a substantial, well-aligned partial diff: 7 files, +260/-116, staged and
  unstaged, matching essentially every offender enumerated in the very
  detailed original task prompt (`arc.ts`, `pg-schema.ts`,
  `structured-write.ts`, `queue-fix-tasks.ts`, `queue.ts`,
  `task-store.ts`, `status-writer-singleton.test.ts`). This is genuinely
  salvageable in-progress work, not throwaway scaffolding.
- `fix-6b227c76` was itself spawned in parallel with this rescue task
  because the failure signature is `unclassified` (no fix recipe
  registered) — see `rescue-operator-spawn.ts` module doc: a rescue fires
  when "an origin task fails with a failure signature for which no fix
  recipe is registered, OR a recovery Chore itself fails". Here the first
  branch fired even though the generic one-recovery-per-origin mechanism
  also fired at the same time — the arc had not actually dead-ended by the
  time this rescue investigated it.

## Verdict: `continue`

The worktree holds salvageable partial work and resuming from the existing
worktree is exactly the right approach — which is precisely what
`fix-6b227c76` is already doing, live. Ran the prescribed command directly:

```
$ mars --repo /Users/ib472e5l/project/perso/mars-framework continue mars-3dcef8b5
mars-3dcef8b5: task mars-3dcef8b5 already has an in-flight recovery
fix-6b227c76; wait for it to complete or use 'mars restart' to discard and
re-run
```

This is the codebase's own in-flight-recovery guard (`continue-task.ts`)
confirming the correct corrective action is already underway — `continue`
is the right verdict, and the system itself is already executing it.

Both other actions were considered and rejected:

- **restart** would hit the identical in-flight-recovery guard
  (`restart-task.ts`) *and* would tear down `fix-6b227c76`'s live worktree
  out from under it — discarding real salvageable work for no reason.
- **supersede** was rejected on the merits (the original prompt is precise
  and correct, not "wrong, unclear, or fundamentally flawed" — the
  offender list it specifies matches the actual diff in progress) and,
  separately, is mechanically dangerous right now: `arc.ts`'s supersede
  path force-removes the superseded task's worktree
  (`git worktree remove --force`) with **no in-flight-recovery guard at
  all**, unlike restart/continue. Invoking it here would have force-removed
  `fix-6b227c76`'s active worktree while its coder session is running,
  corrupting the recovery. (Loose end, not in scope for this rescue:
  `arc.ts`'s supersede path should probably carry the same in-flight-recovery
  guard as `restart-task.ts`/`continue-task.ts` — filed as a follow-up.)

No mutating command beyond the single `mars continue` attempt above was
executed against the arc's task rows or worktree.
