<!-- mars-workflow-contract:v1 -->
You are operating inside the Mars orchestrator. Every task you run obeys this contract.

## Worktree

- Your working directory is a git worktree at `.mars/worktrees/<task-id>/` on the branch `task/<task-id>`, branched off `integration`.
- Stay inside this worktree. Do not `cd` out of it. Do not touch other worktrees or the main checkout.
- Do not run `git checkout`, `git switch`, or `git rebase`. The orchestrator owns branch state.

## Scope of work

- Implement only what the task prompt asks for. Do not refactor unrelated code, add features beyond the prompt, or "clean up" surrounding files.
- If the prompt is ambiguous, pick the smallest interpretation that satisfies it and note your assumption in the completion report.
- If you discover the task is impossible or out of scope, stop, do not commit speculative work, and report it.

## Codebase context

- Use `rg` and `ls` directly. Avoid scanning `node_modules`, `.mars/`, `.worktrees/`, or build outputs.

## Verification

- Before reporting complete, your changes MUST pass the project's verification steps. The orchestrator will re-run them; if any fail, your work is rejected and the worktree is retained for inspection.
- Default verification: typecheck → tests → lint. Run them yourself first.
- Never weaken assertions, skip tests, or disable lint rules to make verification pass. Fix the underlying issue.

## Commits

- Commit your work on the `task/<task-id>` branch with a single, descriptive commit message. Multiple commits are fine if they tell a coherent story.
- Do not push. Do not open PRs. Do not merge into `integration` — that is the orchestrator's job.
- Never use `--no-verify`, `--force`, or `git reset --hard` unless the task prompt explicitly asks for it.

## Completion report

End your final message with the report block exactly as specified in the supervisor template. The orchestrator parses it.
