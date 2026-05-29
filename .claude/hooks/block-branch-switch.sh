#!/usr/bin/env bash
# PreToolUse Bash hook: block commands that switch the checked-out branch when
# running outside an orchestrator worktree. The orchestrator owns branch
# topology (it creates task/<id> branches in isolated worktrees and
# fast-forwards into main). A stray `git checkout`/`git switch` on the primary
# checkout moves HEAD out from under the daemon and the merge pipeline.
#
# Exit 2 = block (stderr is surfaced to the model and aborts the tool call).
# Exit 0 = allow.

set -u

# Inside an orchestrator worktree — allow unconditionally.
# Worktrees live under .mars/worktrees/<task-id>/.
case "${CLAUDE_PROJECT_DIR:-}" in
  */.mars/worktrees/*) exit 0 ;;
esac

input="$(cat)"

# Require jq — fail open if absent so the hook never silently breaks sessions.
command -v jq >/dev/null 2>&1 || exit 0

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"
[ -z "$cmd" ] && exit 0

# Inspect every git invocation in the command (handles &&, ||, ;, and pipes).
# We look for branch-switching verbs:
#   git switch <branch>          (but NOT `git switch -c` alone — still moves HEAD)
#   git checkout <branch>        (branch/commit checkout that moves HEAD)
#   git checkout -b / -B / -c    (create + switch)
#   git worktree add ... -b      handled by git itself in its own dir; skip
# We deliberately allow path-restoring checkouts (`git checkout -- <path>`,
# `git checkout <ref> -- <path>`) since those do not move HEAD.
shopt -s nocasematch

blocked=""

# Split on common command separators so each segment is examined alone.
# Replace separators with newlines, then scan line by line.
segments="$(printf '%s' "$cmd" | sed -E 's/(&&|\|\||;|\|)/\n/g')"

while IFS= read -r seg; do
  # Trim leading whitespace.
  seg="${seg#"${seg%%[![:space:]]*}"}"

  # Only care about git commands.
  [[ "$seg" =~ ^git([[:space:]]|$) ]] || continue
  # Strip a leading `git -C <dir>` / global flags so the subcommand is reachable.
  sub="$(printf '%s' "$seg" | sed -E 's/^git([[:space:]]+(-C[[:space:]]+[^[:space:]]+|-[A-Za-z]+|--[A-Za-z-]+(=[^[:space:]]+)?))*[[:space:]]+//')"

  case "$sub" in
    switch\ *|switch)
      # `git switch` always moves HEAD (with or without -c).
      blocked="git switch" ; break ;;
    checkout\ *)
      args="${sub#checkout }"
      # Path-restore forms do not move HEAD: `checkout -- <path>` or
      # `checkout <ref> -- <path>`.
      if [[ " $args " == *" -- "* ]]; then
        continue
      fi
      blocked="git checkout" ; break ;;
  esac
done <<EOF
$segments
EOF

shopt -u nocasematch

[ -z "$blocked" ] && exit 0

cat >&2 <<BLOCK
[mars] BLOCKED: branch switch ($blocked) on the primary checkout.
       Command: $cmd

       The orchestrator owns branch topology: it creates task/<id> branches in
       isolated worktrees under .mars/worktrees/ and fast-forwards them into
       main. Switching the branch of the primary checkout moves HEAD out from
       under the daemon and the verify/merge pipeline, corrupting in-flight work.

       Do the work through the orchestrator instead:
         mars task add "..."          — enqueue for async coding
         /mars:task from Claude Code  — light-shaping wrapper

       If you genuinely need a branch switch here, do it from a dedicated
       checkout (git worktree) or have the user explicitly opt in for this
       specific change (a prior blanket opt-in does not carry over —
       see CLAUDE.md Routing section).
BLOCK

exit 2
